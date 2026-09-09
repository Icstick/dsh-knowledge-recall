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

export const ALL_LIBS = [
  'lore', 'project', 'hardware', 'software-code',
  'software-config', 'web', 'work-skill', 'workflow',
]

/** 默认知识库目录：$DSH_HOME/weaver-kb/db，回退 ~/.dsh/weaver-kb/db。 */
export function defaultDbDir() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'weaver-kb', 'db')
}

/** LIKE 通配转义。 */
function likeEscape(term) {
  let out = ''
  for (const ch of String(term)) {
    if (ch === '%' || ch === '_' || ch === '\\') out += '\\' + ch
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
  const sql = 'SELECT ' + cols + ' FROM entries WHERE title LIKE ? ESCAPE ' + "'\\'" +
    ' OR tags LIKE ? ESCAPE ' + "'\\'" +
    ' OR summary LIKE ? ESCAPE ' + "'\\'" +
    ' OR body LIKE ? ESCAPE ' + "'\\' LIMIT ?"
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
 * @returns {Promise<Array<{lib,id,title,summary,tags,score,terms:string[],via:string[]}>>}
 */
export async function searchWeaver(terms, {
  dbDir = defaultDbDir(),
  libs = ALL_LIBS,
  minScore = 4,
  maxHits = 4,
  perTermPerLib = 10,
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
  return [...merged.values()]
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
        score: adjustScore(h.score, { confidence: h.confidence, updatedAt }, now),
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
}
