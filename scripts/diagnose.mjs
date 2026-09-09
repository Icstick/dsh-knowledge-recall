#!/usr/bin/env node
/**
 * scripts/diagnose.mjs — 自检索标定（2026-09-09，survey P0-2）。
 *
 * 问题：minScore=4 / perTermPerLib=10 是拍出来的，没有数据支撑。
 * 做法：对每个库抽 N 条条目的标题前 12 字当查询跑一遍自检索，
 * 统计 top-1 / top-4 命中率与分数分布——用真实数据定阈值。
 *
 * 用法：node scripts/diagnose.mjs [--per-lib 30] [--db-dir <path>]
 * 只读；库缺失/损坏自动跳过。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { searchWeaver, ALL_LIBS, defaultDbDir, parseTimestamp } from '../src/search.mjs'
import { extractKeywords } from '../src/recall.mjs'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const perLib = Number.parseInt(argOf('--per-lib', '30'), 10)
/** --no-loose：关闭 CJK bigram 松散匹配，用于 A/B 对照 */
const useLoose = !args.includes('--no-loose')
const dbDir = argOf('--db-dir', defaultDbDir())

function sampleTitles(lib, n) {
  const file = join(dbDir, lib + '.db')
  if (!existsSync(file)) return []
  let db
  try { db = new DatabaseSync(file, { readOnly: true }) } catch { return [] }
  try {
    // 确定性抽样（2026-09-09）：ORDER BY RANDOM() 让两次运行不可比——
    // 按 id 排序后等距取样，同一库同一 n 永远同一批样本。
    const all = db.prepare('SELECT id, title, confidence, updated_at FROM entries ORDER BY id').all()
    const step = Math.max(1, Math.floor(all.length / Math.max(1, n)))
    const picked = []
    for (let i = 0; i < all.length && picked.length < n; i += step) picked.push(all[i])
    return picked
      .map((r) => ({ id: r.id, title: String(r.title ?? ''), confidence: r.confidence, updatedAt: r.updated_at }))
      .filter((r) => r.title.trim().length >= 4)
  } catch { return [] } finally { try { db.close() } catch { /* ignore */ } }
}

const rows = []
const scoreBuckets = []
let withConfidence = 0
let stale = 0
const now = Date.now()

for (const lib of ALL_LIBS) {
  const sample = sampleTitles(lib, perLib)
  if (sample.length === 0) continue
  let top1 = 0
  let top4 = 0
  for (const row of sample) {
    const terms = extractKeywords(row.title.slice(0, 12), { maxTerms: 3 })
    if (terms.length === 0) continue
    if (typeof row.confidence === 'number') withConfidence += 1
    const ts = parseTimestamp(row.updatedAt)
    if (ts !== null && now - ts > 180 * 86400000) stale += 1
    const hits = await searchWeaver(terms, { dbDir, libs: [lib], minScore: 1, maxHits: 4, loose: useLoose })
    for (const h of hits) scoreBuckets.push(h.rawScore)
    if (hits[0]?.id === row.id) top1 += 1
    if (hits.some((h) => h.id === row.id)) top4 += 1
  }
  rows.push({ lib, n: sample.length, top1, top4 })
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) + '%' : 'n/a')
console.log('自检索标定（dbDir=' + dbDir + '，每库抽样 ' + perLib + ' 条）')
console.log('lib'.padEnd(18) + 'n'.padEnd(6) + 'top-1'.padEnd(8) + 'top-4')
for (const r of rows) {
  console.log(r.lib.padEnd(18) + String(r.n).padEnd(6) + pct(r.top1, r.n).padEnd(8) + pct(r.top4, r.n))
}
if (rows.length === 0) {
  console.log('（未找到任何 weaver 库——检查 --db-dir 或 DSH_HOME）')
  process.exit(0)
}
const totalN = rows.reduce((s, r) => s + r.n, 0)
const totalTop1 = rows.reduce((s, r) => s + r.top1, 0)
const totalTop4 = rows.reduce((s, r) => s + r.top4, 0)
scoreBuckets.sort((a, b) => a - b)
const q = (p) => (scoreBuckets.length === 0 ? 'n/a' : scoreBuckets[Math.min(scoreBuckets.length - 1, Math.floor(scoreBuckets.length * p))])
console.log('')
console.log('合计: n=' + totalN + '  top-1=' + pct(totalTop1, totalN) + '  top-4=' + pct(totalTop4, totalN))
console.log('rawScore 分布: p10=' + q(0.1) + ' p50=' + q(0.5) + ' p90=' + q(0.9) + ' max=' + (scoreBuckets.at(-1) ?? 'n/a'))
console.log('样本覆盖: 有 confidence=' + withConfidence + '/' + totalN + '  超过 180 天未更新=' + stale + '/' + totalN)
console.log('')
console.log('怎么用：top-4 命中率低 → minScore 偏高或查询词派生太窄；')
console.log('        rawScore p50 远高于 minScore=4 → 门槛形同虚设，可上调；')
console.log('        陈旧占比高 → 注入行的「未复核」标记不是装饰。')
