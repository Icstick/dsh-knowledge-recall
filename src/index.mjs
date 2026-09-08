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

export { DEFAULT_ALIASES } from './aliases.mjs'

export const name = 'knowledge-recall'

export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 单轮注入预算（tokens）；0 = 关闭注入。 */
  maxTokensPerTurn: z.number().default(400),
  /** 命中最低分（title 命中≈3；默认 4 需 title 或多字段；M2 标定）。 */
  minScore: z.number().default(4),
  /** 检索库列表。 */
  libs: z.array(z.string()).default(ALL_LIBS),
  /** 单轮最多注入条数。 */
  maxHits: z.number().default(4),
  /** 子代理（delegationDepth>0）预算系数。 */
  subagentBudgetFactor: z.number().default(0.5),
  /** 知识库目录（空 = $DSH_HOME/weaver-kb/db 或 ~/.dsh/weaver-kb/db）。 */
  dbDir: z.string().default(''),
  /** 专名/代号 → 查询词（叠加内置表）。 */
  aliases: z.object({}).default({}),
})

const PLUGIN = 'dsh-knowledge-recall'

/** 字符/token 估算系数（中文为主文本的保守折算）。 */
const CHARS_PER_TOKEN = 2

export function apply(ctx, config = {}) {
  const cfg = {
    enabled: true,
    maxTokensPerTurn: 400,
    minScore: 4,
    libs: ALL_LIBS,
    maxHits: 4,
    subagentBudgetFactor: 0.5,
    dbDir: '',
    aliases: {},
    ...(config && typeof config === 'object' ? config : {}),
  }
  const aliases = { ...DEFAULT_ALIASES, ...(cfg.aliases || {}) }
  const dbDir = cfg.dbDir || defaultDbDir()
  const throttle = new RecallThrottle()

  ctx.on('agent/pre-step', async (payload, next) => {
    // 下游先行：拿到含 ACP/WC/maid/time-ink 等注入的完整决策。
    const decision = await next()
    if (!cfg.enabled) return decision
    if (payload?.step !== 1) return decision
    if (!decision || decision.kind !== 'enter') return decision
    try {
      if (!hasRealUserMessage(decision.messages)) return decision
      const sessionId = payload.agent?.session?.id ?? payload.agent?.id ?? ''
      // 子代理预算减半（delegationDepth>0；字段路径 M1 时按宿主对象核实）。
      const agent = payload.agent || {}
      const depth = agent.delegationDepth ?? agent.session?.delegationDepth ?? 0
      const budgetTokens = depth > 0
        ? Math.floor(cfg.maxTokensPerTurn * cfg.subagentBudgetFactor)
        : cfg.maxTokensPerTurn
      if (budgetTokens <= 0) return decision
      // 合计护栏：既有 plugin 注入字符 + 本次 ≤ 900 tokens 估算。
      const already = injectedPluginChars(decision.messages)
      const remainingChars = Math.max(0, TOTAL_INJECT_BUDGET_TOKENS * CHARS_PER_TOKEN - already)
      if (remainingChars <= 0) return decision

      const text = lastRealUserText(decision.messages)
      const terms = extractKeywords(text, { aliases, maxTerms: 6 })
      if (terms.length === 0) return decision

      const hits = await searchWeaver(terms, {
        dbDir,
        libs: cfg.libs,
        minScore: cfg.minScore,
        maxHits: cfg.maxHits,
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

      decision.messages.push(createUserMessage({
        content: [{ type: 'text', text: out.text }],
        source: { kind: 'plugin', plugin: PLUGIN },
      }))
    } catch (err) {
      // fail-open：注入故障不得阻断 turn。
      ctx.logger?.warn?.('[knowledge-recall] inject degraded: '
        + (err instanceof Error ? err.message : String(err)))
    }
    return decision
  })
}
