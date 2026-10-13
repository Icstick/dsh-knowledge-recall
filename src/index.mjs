/**
 * dsh-knowledge-recall：weaver 知识自动召回。
 *
 * 机制（设计文档 docs/design.md，v1 定稿 2026-09-08）：
 *   agent/pre-step waterfall —— 仅 step===1 且决策含真实用户消息时，检索本地
 *   weaver-kb（8 库 SQLite 直读：关键词化 → LIKE/FTS 检索 → 命中过滤）并把命中
 *   条目摘要以 source-labelled user 消息追加到决策尾部（同 ACP/time-ink 注入族）：
 *     - 命中才注入（0 命中 0 token）；预算 ≤ maxTokensPerTurn（子代理 ×0.5）；
 *     - 合计护栏：与 ACP/memento 等既有 plugin 注入合计 ≤ 900 tokens/step；
 *     - 节流：同会话同命中集合不重复注入；
 *     - 主/子代理通吃（子代理收到的任务消息同样触发）。
 *   fail-open：任何检索/注入故障只降级日志，不得阻断回合。
 *   注入记账（2026-10-04）：注入后向 dsh-inject-scheduler 注册段 kr.recall 并上报实际字符数
 *   ——此前从未注册，它的 token 不进任何配额核算、census/conflictPolicy 也看不见它。
 *   调度器是**可选**依赖（缺失只降级不改行为），见下方 KR_SECTION_KEY / registerRecallSection。
 *   语义补充（2026-10-13 自云端 C 收回）：关键词命中不足时补一条向量检索路径。服务端在 C 上
 *   （127.0.0.1:8765，不在本仓）；**本仓 Config.semantic 默认 false** —— A/B/W 没这个服务，
 *   默认开会给每次召回白加一次 400ms 超时的尝试。
 * @module dsh-knowledge-recall
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  hasRealUserMessage,
  lastRealUserText,
  extractKeywords,
  formatHits,
  hitSignature,
  RecallThrottle,
  injectedPluginChars,
  TOTAL_INJECT_BUDGET_TOKENS,
} from './recall.mjs'
import { searchWeaver, semanticSearch, defaultDbDir, ALL_LIBS } from './search.mjs'
import { DEFAULT_ALIASES } from './aliases.mjs'
import {
  load as loadStrength,
  save as saveStrength,
  strengthOf,
  bump as bumpStrength,
  prune as pruneStrength,
  strengthPath,
} from './strength.mjs'

export { DEFAULT_ALIASES } from './aliases.mjs'

export const name = 'knowledge-recall'

export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 单轮注入预算（tokens）；0 = 关闭注入。 */
  maxTokensPerTurn: z.number().default(400),
  /** 命中最低分（title 命中≈3；默认 4 需 title 或多字段；2026-09-09 自检索标定见 README）。 */
  minScore: z.number().default(4),
  /** CJK bigram 松散匹配（2026-09-09）：整词 LIKE 失手的条目按 2-gram 命中率补进候选池（分数打折）。 */
  loose: z.boolean().default(true),
  /** 检索库列表。 */
  libs: z.array(z.string()).default(ALL_LIBS),
  /** 单轮最多注入条数。 */
  maxHits: z.number().default(4),
  /** 会话首回合开场宽检索（放宽词数/阈值）。 */
  openingScan: z.boolean().default(true),
  /** 子代理（delegationDepth>0）预算系数。 */
  subagentBudgetFactor: z.number().default(0.5),
  /** 知识库目录（空 = $DSH_HOME/weaver-kb/db 或 ~/.dsh/weaver-kb/db）。 */
  dbDir: z.string().default(''),
  /**
   * 召回路径是否回写 weaver-kb 的 access_count / last_access（2026-09-10 审计后新增）。
   * 默认 false —— 本仓调研结论明确「不回写 weaver 库」（跨插件写共享 SQLite 有并发与
   * 归属风险，且 weaver 未提供写入 API）；且召回每轮触发，回写会形成自我强化环
   * （召回 → 计数涨 → 排序靠前 → 更易召回）。确需热度数据时才置 true。
   */
  recallHotness: z.boolean().default(false),
  /** 专名/代号 → 查询词（叠加内置表）。 */
  aliases: z.object({}).default({}),
  /**
   * 语义召回（2026-10-05 千寻；2026-10-13 收回本仓）。关键词路径走 LIKE + FTS5，而 unicode61
   * 会把一长串中文整串当一个 token —— 词对不上就是零命中。开启后，关键词命中数低于
   * semanticFallbackBelow 时补一条向量检索路径（本机 semantic-search 服务）。
   * 服务不在/超时/报错一律 fail-open 回到原行为。
   *
   * 默认 **false**（与云端 C 的部署副本不同，那边是 true）：服务端 service.py 只部署在 C 上，
   * A/B/W 三机没有 8765 —— 默认开会给每次召回白加一次超时的尝试。要开先起服务，见 README。
   */
  semantic: z.boolean().default(false),
  /** 语义服务地址（systemd semantic-search.service，绑 127.0.0.1）。 */
  semanticEndpoint: z.string().default('http://127.0.0.1:8765'),
  /** 语义相似度门槛（0..1；越低越宽）。 */
  semanticMinScore: z.number().default(0.42),
  /** 语义查询超时（毫秒）。召回在首步，宁可放弃也不能拖。 */
  semanticTimeoutMs: z.number().default(400),
  /** 关键词命中数 < 此值时才走语义补充（1 = 只在零命中时走）。 */
  semanticFallbackBelow: z.number().default(2),
})

const PLUGIN = 'dsh-knowledge-recall'

/** 设置页配置命名空间（settings.yaml 持久化；重启生效）。 */
export const SETTINGS_NAMESPACE = 'knowledge-recall'

/** 字符/token 估算系数（中文为主文本的保守折算）。 */
const CHARS_PER_TOKEN = 2

// ── 注入调度器接线（2026-10-04 · 审计 P1 修复）────────────────────────────────
// 背景：本插件真在注入，却从未调用 registerSection ⇒ 它每轮的 token 不进任何配额核算，
// conflictPolicy 也检不出它（dsh-inject-scheduler 的 census 里 unregistered 恒挂着它）。
//
// 契约照抄 dsh-adaptive-context / dsh-work-continuity（方案 A：注入方主动上报），三处同形：
//   · 调度器是**可选**依赖——缺失/故障只降级日志，绝不阻断注入与 turn（本仓 fail-open 纪律）；
//   · 本插件在 profile bundles 里排在 dsh-inject-scheduler **之前**（dsh-knowledge-recall
//     → dsh-inject-scheduler），apply 时服务通常还没 provide，所以必须经 internal/service
//     等它就绪，不能只在 apply 里 ctx.get 一次；
//   · 上报量 = 真正 push 进 decision.messages 的那一段文本（out.text），字符级精确。
//
// 与既有段的关系：acp.composer order=10、wc.work_state order=20 都落在 context 带
// （0<order<100，见 dsh-inject-scheduler/src/domain.mjs bandOf）；本插件取 30——同带内递增，
// 避开既有 order（同 order 异 key 才是调度器认定的冲突）。

/** 本插件在注入调度器注册表中的段 key（命名空间小写点分，同 acp.composer / wc.work_state）。 */
export const KR_SECTION_KEY = 'kr.recall'

/** 段序（acp.composer=10 / wc.work_state=20 → 本插件 30）。 */
export const KR_SECTION_ORDER = 30

/** 可选服务就绪即调用（一次 ctx.get + internal/service 订阅等就绪；cordis 4 兼容）。
 *  形态与 dsh-adaptive-context/src/index.mjs 的 withService 一致——三处同形便于对照。 */
function withService(ctx, serviceName, fn) {
  const existing = ctx.get(serviceName)
  if (existing !== undefined && existing !== null) {
    fn(existing)
    return
  }
  const off = ctx.on('internal/service', (name) => {
    if (name !== serviceName) return
    const service = ctx.get(serviceName)
    if (service !== undefined && service !== null) {
      off()
      fn(service)
    }
  })
}

/**
 * 注册 kr.recall 段（幂等覆盖）。budgetChars = maxTokensPerTurn —— 本插件的配额是 token 口径，
 * 故 unit='tokens'（与 acp.composer 同款）。子代理减半只影响单轮实际注入，不改段预算
 * （段预算 = 主代理上限；子代理那半由本插件自己的 budgetTokens 管）。
 */
export function registerRecallSection(ctx, config = {}) {
  withService(ctx, 'injectScheduler', (sched) => {
    if (!sched || typeof sched.registerSection !== 'function') return
    void sched.registerSection({
      key: KR_SECTION_KEY,
      plugin: PLUGIN,
      order: KR_SECTION_ORDER,
      budgetChars: config.maxTokensPerTurn ?? 400,
      unit: 'tokens',
      refresh: 'per-turn',
    }).then((res) => {
      if (res && res.ok === false) {
        // conflictPolicy=reject 下的拒绝是真失败，必须出声（不许静默降级）。
        ctx.logger?.warn?.('[knowledge-recall] section register rejected: '
          + (res.message ?? res.error ?? 'unknown'))
        return
      }
      // 成功只报一行 info：info 不进 startup 日志（只有 warn/error 落盘），
      // 落盘的判据是 $DSH_HOME/storages/inject_scheduler.json 里的 kr.recall 段。
      ctx.logger?.info?.('[knowledge-recall] section ' + KR_SECTION_KEY + ' registered with inject-scheduler')
    }).catch((err) => {
      ctx.logger?.warn?.('[knowledge-recall] section register failed: '
        + (err instanceof Error ? err.message : String(err)))
    })
  })
}

/** 注入后上报实际注入量（fail-open：任何异常/缺失都降级日志，绝不阻断注入与 turn）。 */
export function reportRecallUsage(ctx, sessionId, body) {
  try {
    if (typeof body !== 'string' || body.length === 0) return
    const sched = ctx.get('injectScheduler')
    if (!sched || typeof sched.recordUsage !== 'function') return
    void sched.recordUsage({
      ...(sessionId ? { sessionId } : {}),
      section: KR_SECTION_KEY,
      injectedChars: body.length,
    }).catch((err) => {
      ctx.logger?.warn?.('[knowledge-recall] usage report failed: '
        + (err instanceof Error ? err.message : String(err)))
    })
  } catch (err) {
    ctx.logger?.warn?.('[knowledge-recall] usage report degraded: '
      + (err instanceof Error ? err.message : String(err)))
  }
}

/**
 * 合并两路命中（2026-10-05 千寻）。
 *
 * 关键词路径的 rawScore 是词面分制（title 命中 3 分那套），语义路径是余弦相似度乘 10 ——
 * 两套分不可比，所以这里**不比分数**：关键词结果保持原序在前（既有行为一字不变），
 * 语义结果按相似度降序接在后面补空位，最后按上限截断。同 lib:id 去重（关键词优先）。
 *
 * @param {Array} kw 关键词路径（原序）
 * @param {Array} sem 语义路径（相似度降序）
 * @param {number} max 合并后上限
 */
function mergeHits(kw, sem, max) {
  const seen = new Set()
  const out = []
  for (const h of [...(Array.isArray(kw) ? kw : []), ...(Array.isArray(sem) ? sem : [])]) {
    if (!h || !h.lib || !h.id) continue
    const key = h.lib + ':' + h.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
    if (out.length >= max) break
  }
  return out
}

export function apply(ctx, config = {}) {
  // settings.yaml 持久化值优先（设置页保存 → 重启生效），缺失回退 Config 默认。
  try {
    const settings = ctx.get('settings')
    const section = settings?.get?.(SETTINGS_NAMESPACE)
    if (section && typeof section === 'object') config = { ...config, ...section }
  } catch { /* settings 服务缺失时用 Config */ }
  // 设置页注册（Host 侧；Browser 侧见 client/）
  ctx.inject(['settings'], (settingsCtx) => {
    // dsh >= 0.1.7（#4587）移除了 settings.register：无守卫时这里会抛错。
    // 抛错被 cordis 吞掉、不影响 apply 主体，但会污染启动诊断 —— 无 register 即跳过。
    if (typeof settingsCtx.settings?.register !== 'function') return
    settingsCtx.settings.register(SETTINGS_NAMESPACE, Config)
  })
  const cfg = {
    enabled: true,
    maxTokensPerTurn: 400,
    minScore: 4,
    libs: ALL_LIBS,
    maxHits: 4,
    openingScan: true,
    subagentBudgetFactor: 0.5,
    dbDir: '',
    recallHotness: false,
    aliases: {},
    // 语义补充默认关（见 Config.semantic 注释：服务只部署在 C 上，A/B/W 没有 8765）。
    semantic: false,
    semanticEndpoint: 'http://127.0.0.1:8765',
    semanticMinScore: 0.42,
    semanticTimeoutMs: 400,
    semanticFallbackBelow: 2,
    ...(config && typeof config === 'object' ? config : {}),
  }
  const aliases = { ...DEFAULT_ALIASES, ...(cfg.aliases || {}) }
  const dbDir = cfg.dbDir || defaultDbDir()
  const throttle = new RecallThrottle()
  const firstScanned = new Set()
  // 记忆强度：与 weaver 库分开的单独 JSON，随时可删（见 strength.mjs）。
  const strengthFile = strengthPath()
  const strengthData = loadStrength(strengthFile)
  const strengthFn = (lib, id, nowMs) => strengthOf(strengthData, lib, id, nowMs)

  // 向 dsh-inject-scheduler 注册本段（可选依赖；就绪事件到达时完成注册，见上方接线说明）。
  registerRecallSection(ctx, cfg)

  ctx.on('agent/pre-step', async (payload, next) => {
    // 下游先行：拿到含 ACP/WC/maid/time-ink 等注入的完整决策。
    const decision = await next()
    if (!cfg.enabled) return decision
    if (payload?.step !== 1) return decision
    if (!decision || decision.kind !== 'enter') return decision
    try {
      if (!hasRealUserMessage(decision.messages)) return decision
      const sessionId = payload.agent?.session?.id ?? payload.agent?.id ?? ''
      // 子代理预算减半（delegationDepth 在 session.header；宿主对象核实于 2026-09-08 M1）。
      const agent = payload.agent || {}
      const depth = agent.delegationDepth ?? agent.session?.header?.delegationDepth ?? agent.session?.delegationDepth ?? 0
      const budgetTokens = depth > 0
        ? Math.floor(cfg.maxTokensPerTurn * cfg.subagentBudgetFactor)
        : cfg.maxTokensPerTurn
      if (budgetTokens <= 0) return decision
      // 合计护栏：既有 plugin 注入字符 + 本次 ≤ 900 tokens 估算。
      const already = injectedPluginChars(decision.messages)
      const remainingChars = Math.max(0, TOTAL_INJECT_BUDGET_TOKENS * CHARS_PER_TOKEN - already)
      if (remainingChars <= 0) return decision

      const text = lastRealUserText(decision.messages)
      // 开场宽检索：会话首回合放宽词数与命中数（cfg.openingScan 默认 true）。
      const isFirst = cfg.openingScan && !firstScanned.has(sessionId)
      if (isFirst) firstScanned.add(sessionId)
      const terms = extractKeywords(text, { aliases, maxTerms: isFirst ? 12 : 6 })
      // 抽词为空不再直接放弃（2026-10-05）：语义路径不吃抽词这一步，
      // 而短查询/纯专名恰恰抽不出词 —— 那正是关键词路径的死角。
      // 语义关掉时保持原行为（零词 = 零命中，不走无谓的检索）。
      if (terms.length === 0 && cfg.semantic === false) return decision

      const hitLimit = isFirst ? Math.max(4, cfg.maxHits) : cfg.maxHits
      let hits = await searchWeaver(terms, {
        dbDir,
        libs: cfg.libs,
        minScore: isFirst ? Math.max(2, cfg.minScore - 2) : cfg.minScore,
        maxHits: hitLimit,
        loose: cfg.loose !== false,
        // 默认 false：召回路径不回写生产 weaver-kb（见 Config.recallHotness 注释）
        bumpHotness: cfg.recallHotness === true,
        strengthFn,
      })

      // 语义补充（2026-10-13 自云端 C 收回）：关键词空手或偏少时补一条向量路径。
      // 只有两路都空才算真没料 —— 这正是 FTS5 分词失手时最需要的那一下。
      // semantic 默认 false；服务不可达时 semanticSearch 返回 [] 并回调 onWarn 降级（只 warn，不抛）。
      if (cfg.semantic !== false && hits.length < Math.max(1, Number(cfg.semanticFallbackBelow) || 1)) {
        const sem = await semanticSearch(text, {
          // 宿主 API 到此为止：search.mjs 只认 endpoint 字符串，不认 ctx（AGENTS.md）。
          endpoint: cfg.semanticEndpoint,
          libs: cfg.libs,
          maxHits: hitLimit,
          minScore: cfg.semanticMinScore,
          timeoutMs: cfg.semanticTimeoutMs,
          strengthFn,
          onWarn: (err) => ctx.logger?.warn?.('[knowledge-recall] semantic degraded: '
            + (err instanceof Error ? err.message : String(err))),
        })
        if (sem.length > 0) hits = mergeHits(hits, sem, hitLimit)
      }
      if (hits.length === 0) return decision

      const sig = hitSignature(hits)
      if (throttle.propose(sessionId, sig) === null) return decision

      const out = formatHits(hits, {
        maxTokens: budgetTokens,
        remainingChars,
        maxHits: cfg.maxHits,
        charsPerToken: CHARS_PER_TOKEN,
      })
      if (!out.text) return decision

      // 只对「真正进了注入文本」的条目记一次引用（间隔守卫在 bump 里挡重复）。
      // 写不进就算了——强度是加成，不是回合的必要条件。
      try {
        let changed = false
        for (const h of out.hits || []) {
          if (bumpStrength(strengthData, h.lib, h.id, Date.now())) changed = true
        }
        if (changed) {
          pruneStrength(strengthData)
          saveStrength(strengthFile, strengthData)
        }
      } catch { /* fail-open */ }

      decision.messages.push(createUserMessage({
        content: [{ type: 'text', text: out.text }],
        source: { kind: `plugin:${PLUGIN}` },
      }))

      // 记账：只上报真正进了 decision 的那段文本（fail-open，绝不阻断注入）。
      reportRecallUsage(ctx, sessionId, out.text)
    } catch (err) {
      // fail-open：注入故障不得阻断 turn。
      ctx.logger?.warn?.('[knowledge-recall] inject degraded: '
        + (err instanceof Error ? err.message : String(err)))
    }
    return decision
  })
}
