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
 * 单库单词 LIKE 检索（含 body，取 limit 条聚合）。
 * @returns {Map<string,{lib,id,title,summary,tags,score,terms:Set<string>,via:Set<string>}>}
 */
function likeSearch(db, lib, term, limit) {
  const esc = likeEscape(term)
  const sql = 'SELECT id, title, summary, tags, body FROM entries WHERE title LIKE ? ESCAPE ' + "'\\'" +
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
    const hit = found.get(r.id) || { lib, id: r.id, title: r.title, summary: r.summary, tags: r.tags, score: 0, terms: new Set(), via: new Set(['like']) }
    hit.score += w
    hit.terms.add(term)
    found.set(r.id, hit)
  }
  return found
}

/** 纯拉丁词无 LIKE 命中时的 FTS5 前缀补检。 */
function ftsSearch(db, lib, term, limit) {
  const out = new Map()
  try {
    const quoted = String(term).replace(/"/g, '')
    const rows = db.prepare('SELECT rowid FROM entries_fts WHERE entries_fts MATCH ? LIMIT ?')
      .all('"' + quoted + '"*', limit)
    if (!rows.length) return out
    const get = db.prepare('SELECT id, title, summary, tags FROM entries WHERE rowid = ?')
    for (const r of rows) {
      const e = get.get(r.rowid)
      if (!e) continue
      out.set(e.id, { lib, id: e.id, title: e.title, summary: e.summary, tags: e.tags, score: 4, terms: new Set([term]), via: new Set(['fts']) })
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
    try {
      for (const term of clean) {
        const found = likeSearch(db, lib, term, perTermPerLib)
        if (found.size === 0 && /^[A-Za-z]/.test(term)) {
          const fts = ftsSearch(db, lib, term, perTermPerLib)
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
  return [...merged.values()]
    .map(h => ({ lib: h.lib, id: h.id, title: h.title, summary: h.summary, tags: h.tags, score: h.score, terms: [...h.terms], via: [...h.via] }))
    .filter(h => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxHits)
}
