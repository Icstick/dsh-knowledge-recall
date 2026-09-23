/**
 * 纯函数与工具 —— 消息判定、关键词化、命中格式化、节流。
 * 零依赖，可单测；检索见 search.mjs，插件入口见 index.mjs。
 * @module dsh-knowledge-recall/recall
 */

/** 真实用户消息判定：role=user 且 source.kind='user'（排除一切插件/系统注入）。 */
export function isRealUserMessage(message) {
  return message !== null && typeof message === 'object'
    && message.role === 'user'
    && message.source !== null && typeof message.source === 'object'
    && message.source.kind === 'user'
}

/** 消息列表里是否存在真实用户消息。 */
export function hasRealUserMessage(messages) {
  return Array.isArray(messages) && messages.some(isRealUserMessage)
}

/** 取消息纯文本（content[].type==='text' 拼接）。 */
export function messageText(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  const out = []
  for (const seg of content) {
    if (seg && seg.type === 'text' && typeof seg.text === 'string') out.push(seg.text)
  }
  return out.join('\n')
}

/** 最后一条真实用户消息文本（无则空串）。 */
export function lastRealUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) return messageText(messages[i])
  }
  return ''
}

const LATIN_STOP = new Set([
  'the','and','for','with','from','this','that','these','those','you','your','are','was','were',
  'how','what','why','when','where','which','who','can','could','will','would','should','shall',
  'have','has','had','not','but','its','into','about','after','before','more','most','than','then',
  'them','they','their','there','here','out','our','one','two','new','use','used','using','make',
  'made','like','just','please','help','need','want','work','file','files','code','see','look',
])
const CJK_RE = /[\u4e00-\u9fff]+/g
const LATIN_RE = /[A-Za-z][A-Za-z0-9_-]{2,}/g

/** CJK 引导/语气前缀（命中则剥离；剩余不足 4 字丢弃该段）。 */
const CJK_LEAD = [
  '帮我看看', '帮我查', '帮忙看看', '帮我一下', '请问一下', '麻烦帮我',
  '怎么配置', '怎么样', '怎么做', '如何配置', '如何实现', '怎么弄',
  '有没有', '是不是', '能不能', '可不可以', '那些', '这个', '那个',
  '我们', '咱们', '需要', '相关', '什么', '一下', '帮我', '看看',
  '请问', '麻烦', '想要', '想把', '可以', '一起', '继续', '关于',
]

/** 剥除样板块（[acp:...] 行首块、system-reminder 等），避免样板词进查询。 */
export function stripBoilerplate(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/\[acp:[^\]]*\][^\n]*/g, ' ')
    .replace(/\[work-state\][\s\S]*?(?=\n\n|$)/g, ' ')
    .replace(/\[knowledge-recall\][^\n]*/g, ' ')
}

/** 正则转义（逐字符，避免字符类嵌套转义坑）。 */
function escapeRegExp(word) {
  let out = ''
  for (const ch of String(word)) {
    if ('.*+?^$()[]{}|\\-'.includes(ch)) out += '\\' + ch
    else out += ch
  }
  return out
}

/** 拉丁词是否命中文本（词边界）。 */
function hasLatinWord(text, word) {
  const esc = escapeRegExp(word)
  return new RegExp('(?:^|[^A-Za-z0-9_-])' + esc + '(?:$|[^A-Za-z0-9_-])', 'i').test(text)
}

/**
 * 关键词化：别名命中优先，其次拉丁词（过滤停用），最后 CJK 滑窗。
 * @param {string} text 真实用户消息文本
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.aliases] 专名→查询词
 * @param {number} [opts.maxTerms] 输出上限（默认 6）
 * @returns {string[]} 有序查询词（去重）
 */
export function extractKeywords(text, { aliases = {}, maxTerms = 6 } = {}) {
  const clean = stripBoilerplate(String(text || ''))
  const terms = []
  const seen = new Set()
  const push = (t) => {
    // 空格分词：别名值可含多词（如 '干员 基建'）。
    for (const part of String(t || '').split(/\s+/)) {
      const v = part.trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      terms.push(v)
    }
  }
  const hitAliasKeys = new Set()
  // 1) 别名命中（CJK key 用 includes；拉丁 key 用词边界）
  for (const [key, value] of Object.entries(aliases)) {
    if (!key) continue
    const hit = /[\u4e00-\u9fff]/.test(key)
      ? clean.includes(key)
      : hasLatinWord(clean, key)
    if (hit) {
      push(value || key)
      hitAliasKeys.add(String(key).toLowerCase())
    }
  }
  // 2) 拉丁词（保序去停用；跳过已由别名命中的 key）
  for (const m of clean.match(LATIN_RE) || []) {
    const w = m.toLowerCase()
    if (w.length >= 3 && !LATIN_STOP.has(w) && !hitAliasKeys.has(w)) push(w)
    if (terms.length >= maxTerms) break
  }
  // 3) CJK 滑窗（4~12 字整段；>12 滑窗；剥离引导前缀）
  for (const raw of clean.match(CJK_RE) || []) {
    let seg = raw
    for (const lead of CJK_LEAD) {
      if (seg.startsWith(lead)) { seg = seg.slice(lead.length); break }
    }
    if (seg.length < 4) continue
    if (seg.length <= 12) push(seg)
    else {
      push(seg.slice(0, 12))
      for (let s = 8; s + 8 <= seg.length && terms.length < maxTerms; s += 8) {
        push(seg.slice(s, s + 12))
      }
    }
    if (terms.length >= maxTerms) break
  }
  return terms.slice(0, maxTerms)
}

/** 命中条目 → 紧凑注入文本（预算字符上限；返回空串=无可注入）。 */
export function formatHits(hits, { maxTokens = 400, remainingChars = Infinity, maxHits = 4, charsPerToken = 2 } = {}) {
  if (!Array.isArray(hits) || hits.length === 0) return { text: '', hits: [] }
  const budget = Math.max(0, Math.min(maxTokens * charsPerToken, remainingChars))
  const lines = []
  const used = []
  let chars = 0
  for (const h of hits.slice(0, maxHits)) {
    const title = String(h.title || '').slice(0, 60)
    const summary = String(h.summary || '').replace(/\s+/g, ' ').slice(0, 160)
    // 2026-09-09：把库里已有却一直没读的 confidence/updated_at 带给模型——
    // 让它自己知道这条有多新多稳（陈旧条目附「未复核」标记）。
    const meta = []
    if (typeof h.confidence === 'number' && Number.isFinite(h.confidence)) meta.push('conf=' + h.confidence.toFixed(1))
    if (h.updatedAt) {
      const day = new Date(h.updatedAt).toISOString().slice(0, 10)
      meta.push((h.stale ? '未复核·更新于 ' : '更新于 ') + day)
    }
    const line = '[knowledge-recall] weaver ' + h.lib + '/' + h.id + '《' + title + '》：' + summary
      + (meta.length > 0 ? ' · ' + meta.join(' · ') : '')
    if (chars + line.length + 1 > budget) break
    lines.push(line)
    used.push(h)
    chars += line.length + 1
  }
  return { text: lines.join('\n'), hits: used }
}

/** 命中集合签名（节流去重用）。 */
export function hitSignature(hits, n = 3) {
  return (Array.isArray(hits) ? hits.slice(0, n) : []).map(h => h.lib + '/' + h.id).join(',')
}

/** 每会话节流：相同签名不重复注入（有界 Map）。 */
export class RecallThrottle {
  constructor(limit = 2000) { this.limit = limit; this.sigBySession = new Map() }
  propose(sessionId, sig) {
    if (!sig) return null
    if (this.sigBySession.get(sessionId) === sig) return null
    if (this.sigBySession.size >= this.limit && !this.sigBySession.has(sessionId)) {
      const first = this.sigBySession.keys().next().value
      this.sigBySession.delete(first)
    }
    this.sigBySession.set(sessionId, sig)
    return sig
  }
}

/** 合计护栏常量：本插件与 ACP/memento 等插件注入合计预算（tokens/step，参照 ACP 预算承诺）。 */
export const TOTAL_INJECT_BUDGET_TOKENS = 900

/** 统计 decision.messages 中外部插件注入文本总字符数。 */
export function injectedPluginChars(messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const m of messages) {
    if (m && m.role === 'user' && m.source && typeof m.source.kind === 'string'
      && (m.source.kind === 'plugin' || m.source.kind.startsWith('plugin:'))) {
      total += messageText(m).length
    }
  }
  return total
}
