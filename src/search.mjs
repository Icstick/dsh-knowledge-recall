/**
 * weaver-kb SQLite 检索 —— 直读 $DSH_HOME/weaver-kb/db/<lib>.db。
 * 语义对齐 weaver_search：短词、CJK 子串（LIKE）；纯拉丁词无 LIKE 命中时补 FTS5 前缀匹配。
 * 零运行依赖（node:sqlite 内置）；任一库缺失/损坏 fail-open 跳过。
 * @module dsh-knowledge-recall/search
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STRENGTH_WEIGHT } from './strength.mjs'

export const ALL_LIBS = [
  'lore', 'project', 'hardware', 'software-code',
  'software-config', 'web', 'work-skill', 'workflow',
]

/** 默认知识库目录：$DSH_HOME/weaver-kb/db，回退 ~/.dsh/weaver-kb/db。 */
export function defaultDbDir() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'weaver-kb', 'db')
}

/**
 * LIKE 通配转义（2026-09-10）。
 * 用 '!' 而不是反斜杠作转义字符：反斜杠在 JS 字符串 → SQL 字面量 → SQLite ESCAPE 之间
 * 要穿过三层转义，实际跑出来是 ESCAPE '\\\\'（两个字符），SQLite 会报
 * "ESCAPE expression must be a single character"，而该异常被 catch 静默吞掉——
 * 于是整词 LIKE 与松散匹配两条路径长期静默失效。用 '!' 彻底消除歧义。
 */
function likeEscape(term) {
  let out = ''
  for (const ch of String(term)) {
    if (ch === '%' || ch === '_' || ch === '!') out += '!' + ch
    else out += ch
  }
  return out
}

/** 字段命中权重（title 最高，tags 次之，body 最低）。 */
const FIELD_WEIGHT = { title: 3, tags: 2, summary: 2, body: 1 }

/**
 * updated_at 归一（2026-09-09）。实测 weaver 库里有三种格式：
 * ISO 带 Z / ISO 不带 Z / epoch 秒（如 1784013556）——解析必须先兼容再谈陈旧度。
 * @returns {number|null} 毫秒时间戳；无法解析 → null
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  const s = String(value).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n > 1e12 ? n : n * 1000
  }
  // 无时区的 ISO → 按 UTC 解释（weaver 写入口径）
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** 陈旧阈值与惩罚（survey §3.4：超期降权，不是直接丢弃） */
export const STALE_DAYS = 180
const STALE_PENALTY = 0.8
/** 置信度地板：conf=0 → ×0.5，conf=1 → ×1.0（线性） */
const CONFIDENCE_FLOOR = 0.5

/** 分数调整：置信度 + 陈旧度（两者都来自库里已有却一直没读的列）。 */
function adjustScore(score, { confidence, updatedAt }, now) {
  let s = score
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    const c = Math.max(0, Math.min(1, confidence))
    s *= CONFIDENCE_FLOOR + (1 - CONFIDENCE_FLOOR) * c
  }
  if (updatedAt !== null && now - updatedAt > STALE_DAYS * 86400000) s *= STALE_PENALTY
  return s
}

/**
 * 单库单词 LIKE 检索（含 body，取 limit 条聚合）。
 * @returns {Map<string,{lib,id,title,summary,tags,score,terms:Set<string>,via:Set<string>}>}
 */
function likeSearch(db, lib, term, limit, hasMeta = true) {
  const esc = likeEscape(term)
  const cols = hasMeta ? 'id, title, summary, tags, body, confidence, updated_at' : 'id, title, summary, tags, body'
  const sql = 'SELECT ' + cols + ' FROM entries WHERE title LIKE ? ESCAPE ' + "'!'" +
    ' OR tags LIKE ? ESCAPE ' + "'!'" +
    ' OR summary LIKE ? ESCAPE ' + "'!'" +
    ' OR body LIKE ? ESCAPE ' + "'!' LIMIT ?"
  const rows = db.prepare(sql).all('%' + esc + '%', '%' + esc + '%', '%' + esc + '%', '%' + esc + '%', limit)
  const found = new Map()
  for (const r of rows) {
    const w = (String(r.title || '').includes(term) ? FIELD_WEIGHT.title : 0)
      + (String(r.tags || '').includes(term) ? FIELD_WEIGHT.tags : 0)
      + (String(r.summary || '').includes(term) ? FIELD_WEIGHT.summary : 0)
      + (String(r.body || '').includes(term) ? FIELD_WEIGHT.body : 0)
    const hit = found.get(r.id) || { lib, id: r.id, title: r.title, summary: r.summary, tags: r.tags, score: 0, terms: new Set(), via: new Set(['like']), confidence: r.confidence, updatedAt: r.updated_at }
    hit.score += w
    hit.terms.add(term)
    found.set(r.id, hit)
  }
  return found
}

/** 松散匹配惩罚：bigram 命中不等于整词命中，分数按比例打折 */
const LOOSE_PENALTY = 0.8

/**
 * CJK bigram 分解（2026-09-09，survey P0-1 的过渡版）。
 * 中文没有分词，LIKE 只能整词子串匹配——「干员基建」命中不了写着「基建干员」的条目。
 * 把查询词切成重叠 2-gram 做 OR 匹配、按命中率打分，补上"部分命中"这条路。
 * 说明：这不是 FTS5 trigram 影子索引（那还带性能收益）；9.8k 行的规模下 LIKE 已经够快，
 * 真正的瓶颈是匹配松紧而非速度。
 * @param {string} term
 * @returns {string[]}
 */
export function cjkBigrams(term) {
  const s = String(term ?? '')
  const out = []
  const seen = new Set()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    if (/[\u4e00-\u9fff]/.test(g) && !seen.has(g)) { seen.add(g); out.push(g) }
  }
  return out
}

/** 松散匹配检索：bigram OR 查询 + 命中率加权（仅 CJK 词、且整词无命中时兜底调用）。 */
function likeSearchLoose(db, lib, term, limit, hasMeta = true) {
  const grams = cjkBigrams(term)
  if (grams.length === 0) return new Map()
  const cols = hasMeta ? 'id, title, summary, tags, body, confidence, updated_at' : 'id, title, summary, tags, body'
  const clause = '(title LIKE ? ESCAPE ' + "'!'" + ' OR tags LIKE ? ESCAPE ' + "'!'" +
    ' OR summary LIKE ? ESCAPE ' + "'!'" + ' OR body LIKE ? ESCAPE ' + "'!'" + ')'
  const where = grams.map(() => clause).join(' OR ')
  const params = []
  for (const g of grams) {
    const p = '%' + likeEscape(g) + '%'
    params.push(p, p, p, p)
  }
  params.push(limit)
  let rows
  try { rows = db.prepare('SELECT ' + cols + ' FROM entries WHERE ' + where + ' LIMIT ?').all(...params) } catch { return new Map() }
  const found = new Map()
  const fields = [['title', FIELD_WEIGHT.title], ['tags', FIELD_WEIGHT.tags], ['summary', FIELD_WEIGHT.summary], ['body', FIELD_WEIGHT.body]]
  for (const r of rows) {
    let w = 0
    for (const [name, fw] of fields) {
      const text = String(r[name] || '')
      if (!text) continue
      let hit = 0
      for (const g of grams) if (text.includes(g)) hit += 1
      if (hit > 0) w += fw * (hit / grams.length)
    }
    if (w <= 0) continue
    found.set(r.id, {
      lib, id: r.id, title: r.title, summary: r.summary, tags: r.tags,
      score: w * LOOSE_PENALTY, terms: new Set([term]), via: new Set(['like-loose']),
      confidence: r.confidence, updatedAt: r.updated_at,
    })
  }
  return found
}

/** 纯拉丁词无 LIKE 命中时的 FTS5 前缀补检。 */
function ftsSearch(db, lib, term, limit, hasMeta = true) {
  const out = new Map()
  try {
    const quoted = String(term).replace(/"/g, '')
    const rows = db.prepare('SELECT rowid FROM entries_fts WHERE entries_fts MATCH ? LIMIT ?')
      .all('"' + quoted + '"*', limit)
    if (!rows.length) return out
    const get = db.prepare('SELECT ' + (hasMeta ? 'id, title, summary, tags, confidence, updated_at' : 'id, title, summary, tags') + ' FROM entries WHERE rowid = ?')
    for (const r of rows) {
      const e = get.get(r.rowid)
      if (!e) continue
      out.set(e.id, { lib, id: e.id, title: e.title, summary: e.summary, tags: e.tags, score: 4, terms: new Set([term]), via: new Set(['fts']), confidence: e.confidence, updatedAt: e.updated_at })
    }
  } catch { /* FTS 不可用/损坏时静默 */ }
  return out
}

/**
 * 主检索：按 terms 顺序逐词跨库查询并聚分。
 * @param {string[]} terms 有序查询词（extractKeywords 输出）
 * @param {object} [opts]
 * @param {string} [opts.dbDir]
 * @param {string[]} [opts.libs]
 * @param {number} [opts.minScore] 最低分（默认 4 ≈ title 级命中）
 * @param {number} [opts.maxHits] 返回上限
 * @param {number} [opts.perTermPerLib] 每词每库 LIKE 上限
 * @param {boolean} [opts.bumpHotness] 是否回写 weaver-kb 的 access_count/last_access（默认 false）
 * @returns {Promise<Array<{lib,id,title,summary,tags,score,terms:string[],via:string[]}>>}
 */
export async function searchWeaver(terms, {
  dbDir = defaultDbDir(),
  libs = ALL_LIBS,
  minScore = 4,
  maxHits = 4,
  perTermPerLib = 10,
  loose = true,
  bumpHotness = false,
  strengthFn = null,
} = {}) {
  const clean = (Array.isArray(terms) ? terms : []).map(t => String(t).trim()).filter(Boolean)
  if (clean.length === 0) return []
  const merged = new Map()
  for (const lib of libs) {
    const file = join(dbDir, lib + '.db')
    if (!existsSync(file)) continue
    let db
    try { db = new DatabaseSync(file, { readOnly: true }) } catch { continue }
    // 元数据列可用性探测（2026-09-09）：旧库可能没有 confidence/updated_at，
    // 硬 SELECT 会让整个库的检索抛错——探测后降级为旧列集。
    let hasMeta = true
    try {
      const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => String(c.name))
      hasMeta = cols.includes('confidence') && cols.includes('updated_at')
    } catch { hasMeta = false }
    try {
      for (const term of clean) {
        const found = likeSearch(db, lib, term, perTermPerLib, hasMeta)
        // CJK 词：再跑一遍 bigram 松散匹配，**只补整词没命中的条目**——
        // 整词命中者保持原分，避免同一篇被两路重复计分。
        if (loose && /[\u4e00-\u9fff]/.test(term)) {
          const looseHits = likeSearchLoose(db, lib, term, perTermPerLib, hasMeta)
          for (const [id, h] of looseHits) if (!found.has(id)) found.set(id, h)
        }
        if (found.size === 0 && /^[A-Za-z]/.test(term)) {
          const fts = ftsSearch(db, lib, term, perTermPerLib, hasMeta)
          for (const [id, h] of fts) {
            const m = merged.get(id) || h
            if (merged.has(id)) { m.score += h.score; for (const t of h.terms) m.terms.add(t) }
            merged.set(id, m)
          }
          continue
        }
        for (const [id, h] of found) {
          const m = merged.get(id)
          if (m) {
            m.score += h.score
            for (const t of h.terms) m.terms.add(t)
          } else {
            merged.set(id, h)
          }
        }
      }
    } finally {
      try { db.close() } catch { /* ignore */ }
    }
  }
  const now = Date.now()
  const hits = [...merged.values()]
    .map((h) => {
      const updatedAt = parseTimestamp(h.updatedAt)
      const stale = updatedAt !== null && (now - updatedAt) > STALE_DAYS * 86400000
      return {
        lib: h.lib,
        id: h.id,
        title: h.title,
        summary: h.summary,
        tags: h.tags,
        // rawScore = 纯词面命中分（用于 minScore 门槛，保证召回量不因降权而缩水）；
        // score = 置信度/陈旧度调整后的排序分（用于排序与展示）
        rawScore: h.score,
        // score = 置信度/陈旧度调整后，再乘记忆强度加成（最多 +20%，见 strength.mjs）。
        // 强度只做弱加权：相关性仍是主导；没有强度数据时乘子恒为 1（fail-open）。
        score: adjustScore(h.score, { confidence: h.confidence, updatedAt }, now)
          * (1 + STRENGTH_WEIGHT * (typeof strengthFn === 'function' ? (Number(strengthFn(h.lib, h.id, now)) || 0) : 0)),
        terms: [...h.terms],
        via: [...h.via],
        // 2026-09-09：库里早就有 confidence/updated_at，此前从未被读过——现在带出来
        confidence: typeof h.confidence === 'number' && Number.isFinite(h.confidence) ? h.confidence : null,
        updatedAt,
        stale,
      }
    })
    .filter(h => h.rawScore >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxHits)

  // 2026-09-10 审计修正：回写改为显式开启（bumpHotness，默认 false）。
  // 原因有二：
  //   1) 本仓调研结论（docs/research/PEER-SURVEY-20260909.md §"不回写 weaver 库"）已明确
  //      「跨插件写共享 SQLite 有并发与归属风险，且 weaver 未提供写入 API」——默认回写与之相悖；
  //   2) 召回路径每轮触发，回写会形成自我强化环（召回→计数涨→排序靠前→更易召回）。
  // 需要热度数据时由调用方显式传 bumpHotness: true（best-effort，写失败不影响注入）。
  if (bumpHotness) bumpAccessCounts(hits, dbDir)
  return hits
}

/**
 * 累加命中的 access_count / last_access（2026-09-10）。
 * 写连接用 busy_timeout=3000 + 一次重试吸收并发；本函数从不抛错。
 * @returns {number} 实际更新的行数（失败为 0）
 */
export function bumpAccessCounts(hits, dbDir = defaultDbDir()) {
  const byLib = new Map()
  for (const h of hits ?? []) {
    if (!h || !h.lib || !h.id) continue
    if (!byLib.has(h.lib)) byLib.set(h.lib, [])
    byLib.get(h.lib).push(h.id)
  }
  let total = 0
  for (const [lib, ids] of byLib) {
    const file = join(dbDir, lib + '.db')
    if (!existsSync(file)) continue
    for (let attempt = 0; attempt < 2; attempt++) {
      let db
      try {
        db = new DatabaseSync(file)
        db.exec('PRAGMA busy_timeout = 3000')
        const stmt = db.prepare('UPDATE entries SET access_count = access_count + 1, last_access = ? WHERE id = ?')
        const ts = new Date().toISOString()
        for (const id of ids) total += stmt.run(ts, id).changes ?? 0
        break
      } catch { /* 静默：只读/加锁/无该列都只是没有热度数据而已 */ } finally {
        try { if (db) db.close() } catch { /* ignore */ }
      }
    }
  }
  return total
}

/**
 * 语义路径（2026-10-05 千寻于云端；2026-10-13 收回本仓）。
 *
 * 为什么需要它：上面那条关键词路径依赖 LIKE + FTS5。库里是中文为主，
 * unicode61 会把一长串中文整串当成一个 token —— 「昨天那个检索的坑」这种句子
 * 抽出来的词跟正文对不上，就是零命中。语义这边把整句编码成向量查。
 *
 * 服务端**不在本仓**：~/cloud_workspace/embed/service.py（systemd semantic-search.service，
 * 绑 127.0.0.1:8765，bge-small-zh-v1.5 ONNX / CPU）。A/B/W 三机没有这个服务
 * —— 故本插件 Config.semantic 默认 false（见 index.mjs），开了也只会白等一次超时。
 * 线上契约（2026-10-13 实测 C 侧 8765）：
 *   GET /search?q=<整句>&k=<条数>&min=<门槛>&libs=<逗号分隔>
 *   -> {ok, tookMs, q, min, hits:[{lib,id,title,summary,tags,score,confidence,updatedAt}]}
 *   score = 0..1 的余弦相似度；server 侧任何异常都返回 ok:false，不抛给调用方。
 *
 * 契约与上面一致：返回结构对齐 searchWeaver，可直接进 formatHits。
 * fail-open —— 服务没起、超时、返回异常，一律返回空数组，绝不阻断召回。
 *
 * 宿主纪律：本函数只认 endpoint 字符串，**不接受 ctx**——search.mjs 不得依赖宿主 API，
 * 由 index.mjs 把 config 里的地址传进来（见 AGENTS.md）。
 *
 * @param {string} query 原始查询文本（整句，不抽词）
 * @param {object} [opts]
 * @param {string} [opts.endpoint] 服务地址
 * @param {string[]} [opts.libs] 限定库
 * @param {number} [opts.maxHits] 返回上限
 * @param {number} [opts.minScore] 相似度门槛（0..1）
 * @param {number} [opts.timeoutMs] 超时（召回在首步，不能拖）
 * @param {Function} [opts.onWarn] 降级回调
 * @param {Function} [opts.strengthFn] 记忆强度回调，签名同 searchWeaver
 * @returns {Promise<Array<{lib,id,title,summary,tags,rawScore,score,terms,via,confidence,updatedAt,stale}>>}
 */
export async function semanticSearch(query, {
  endpoint = 'http://127.0.0.1:8765',
  libs = ALL_LIBS,
  maxHits = 4,
  minScore = 0.42,
  timeoutMs = 400,
  onWarn = null,
  strengthFn = null,
} = {}) {
  const q = String(query ?? '').trim()
  if (!q) return []
  if (typeof fetch !== 'function') return []
  const params = new URLSearchParams({ q, k: String(maxHits), min: String(minScore) })
  if (Array.isArray(libs) && libs.length > 0) params.set('libs', libs.join(','))
  let payload
  try {
    const res = await fetch(endpoint + '/search?' + params.toString(), {
      signal: AbortSignal.timeout(Math.max(50, Number(timeoutMs) || 400)),
    })
    if (!res.ok) return []
    payload = await res.json()
  } catch (err) {
    // 服务不在（还没起 / 挂了 / 超时）都走这里：这是旁路，不是主路。
    if (typeof onWarn === 'function') onWarn(err)
    return []
  }
  if (!payload || payload.ok !== true || !Array.isArray(payload.hits)) return []
  const now = Date.now()
  return payload.hits
    .slice(0, maxHits)
    .map((h) => {
      const sim = Number(h.score)
      if (!Number.isFinite(sim)) return null
      const updatedAt = parseTimestamp(h.updatedAt)
      const stale = updatedAt !== null && (now - updatedAt) > STALE_DAYS * 86400000
      // 分制换算：关键词路径 rawScore 走「title 命中 3 分」这套，
      // 语义是 0..1 的余弦。乘 10 只为让它落在同一量级、走同一套置信度/陈旧度调整，
      // 不与关键词分直接比较（调用方靠顺序而非分值合并两路）。
      const raw = sim * 10
      const confidence = (typeof h.confidence === 'number' && Number.isFinite(h.confidence)) ? h.confidence : null
      return {
        lib: String(h.lib ?? ''),
        id: String(h.id ?? ''),
        title: String(h.title ?? ''),
        summary: String(h.summary ?? ''),
        tags: String(h.tags ?? '[]'),
        rawScore: raw,
        score: adjustScore(raw, { confidence, updatedAt }, now)
          * (1 + STRENGTH_WEIGHT * (typeof strengthFn === 'function' ? (Number(strengthFn(String(h.lib ?? ''), String(h.id ?? ''), now)) || 0) : 0)),
        // 语义命中没有词面证据：terms 留空、via 标注来源，
        // 注入文本里 formatHits 不会因此崩（它对 terms 只做展示）。
        terms: [],
        via: ['semantic'],
        confidence,
        updatedAt,
        stale,
      }
    })
    .filter((h) => h && h.lib && h.id)
}
