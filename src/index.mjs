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
import { searchWeaver, defaultDbDir, ALL_LIBS } from './search.mjs'
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
})

const PLUGIN = 'dsh-knowledge-recall'

/** 设置页配置命名空间（settings.yaml 持久化；重启生效）。 */
export const SETTINGS_NAMESPACE = 'knowledge-recall'

/** 字符/token 估算系数（中文为主文本的保守折算）。 */
const CHARS_PER_TOKEN = 2

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
      if (terms.length === 0) return decision

      const hits = await searchWeaver(terms, {
        dbDir,
        libs: cfg.libs,
        minScore: isFirst ? Math.max(2, cfg.minScore - 2) : cfg.minScore,
        maxHits: isFirst ? Math.max(4, cfg.maxHits) : cfg.maxHits,
        loose: cfg.loose !== false,
        // 默认 false：召回路径不回写生产 weaver-kb（见 Config.recallHotness 注释）
        bumpHotness: cfg.recallHotness === true,
        strengthFn,
      })
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
    } catch (err) {
      // fail-open：注入故障不得阻断 turn。
      ctx.logger?.warn?.('[knowledge-recall] inject degraded: '
        + (err instanceof Error ? err.message : String(err)))
    }
    return decision
  })
}
