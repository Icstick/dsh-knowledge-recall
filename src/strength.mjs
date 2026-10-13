/**
 * 记忆强度：引用计数 + 半衰期。
 *
 * 为什么要有它：召回的排序现在只看「词面命中 × 置信度 × 陈旧度」，
 * 从不看「这条以前有没有被真正用过」。于是沉淀下来的经验，和一条从没被翻开过的
 * 条目同权——这是"记得多、学得少"在排序层的表现。
 *
 * 为什么不能写回库里：2026-09-10 的审计已经指出过——
 *   1) 跨插件写共享 SQLite 有并发与归属风险，且 weaver 是权威只读；
 *   2) **召回路径每轮触发，回写会形成自我强化环**（召回→计数涨→排序靠前→更易召回）。
 * 所以本模块只做三件事，且全部落在**自己的单独 JSON**上：
 *   - 只记「真正进了注入文本」的条目（用 formatHits 返回的 hits，不是全部命中）；
 *   - 间隔守卫：半天内对同一条目只计一次；
 *   - 强度是凹的（ln）+ 带半衰期（90 天）：涨得越来越慢，不用就落回去。
 * 排序里只做**弱加权**（最多 +20%），相关性仍是主导——强度是加成，不是替代。
 *
 * 来源：云端 2026-10-01/02 的实现（dsh-kokonoe-moment 同期），本仓 2026-10-02 移植。
 * fail-open：读不到 / 写不进 / JSON 坏了，一律当"没有强度数据"，绝不抛。
 * @module dsh-knowledge-recall/strength
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 半衰期：90 天不用，强度掉一半。 */
export const HALF_LIFE_DAYS = 90
/** 归一化上限：引用到 8 次即视为"常用"，再涨收益递减。 */
export const N_CAP = 8
/**
 * 排序权重：最多把排序分抬高 20%。
 * 依据是云端一次可控实验：0.35 能让 5.70 翻过 7.69 —— **能翻过 35% 的相关性差距**，
 * 对「词面命中分」这个尺度（约 3–8）来说太大。0.20 只翻得过约 20% 的差距。
 */
export const STRENGTH_WEIGHT = 0.2
/**
 * 计入门槛：引用次数达到它才算「常用」。一次是偶然，两次才是习惯。
 */
export const MIN_N = 2
/** 间隔守卫：半天内的重复引用不算新的（spacing effect）。 */
const SAME_DAY_MS = 12 * 3600 * 1000
const MAX_ENTRIES = 4000

/**
 * 默认落在 $DSH_HOME/memory-strength.json（与 weaver 库分开，随时可删）。
 *
 * 2026-10-13：DSH_HOME 未设时的兜底改成**按存在性探测**。
 * 起因：C 机（cloud-server）的交互家是 `~/.dsh-web`（systemd 里钉的 DSH_HOME），
 * 而 A/W 的默认家是 `~/.dsh`；两侧原先各写死一个，导致同一份代码在两处行为不同。
 * 现在：`.dsh` 优先（保住「默认家」这个约定），那里没有该文件才落到 `.dsh-web`。
 * 判据用 existsSync 而不是「目录在不在」——C 上 `~/.dsh` 也存在（那是 headless worker 的家），
 * 但没有 knowledge-recall 在跑，所以它不会有这个文件。
 */
export function strengthPath(env = process.env) {
  if (env.DSH_HOME) return path.join(env.DSH_HOME, 'memory-strength.json')
  for (const dir of ['.dsh', '.dsh-web']) {
    const p = path.join(os.homedir(), dir, 'memory-strength.json')
    try { if (fs.existsSync(p)) return p } catch { /* fail-open：探测失败就当它不在 */ }
  }
  return path.join(os.homedir(), '.dsh', 'memory-strength.json')
}

/** 读；缺文件或坏 JSON 都返回空表。 */
export function load(pathname) {
  try {
    const o = JSON.parse(fs.readFileSync(pathname, 'utf8'))
    if (o && typeof o === 'object' && o.entries && typeof o.entries === 'object') return o
  } catch { /* 当空 */ }
  return { version: 1, entries: {} }
}

/** 原子写；失败返回 false（调用方可以忽略）。 */
export function save(pathname, data) {
  try {
    const tmp = pathname + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, pathname)
    return true
  } catch { return false }
}

/** 强度 0..1；没有记录 = 0。 */
export function strengthOf(data, lib, id, now) {
  const e = data && data.entries ? data.entries[lib + '/' + id] : null
  if (!e) return 0
  const n = Math.max(0, Number(e.n) || 0)
  if (n < MIN_N) return 0
  const t = Date.parse(e.last)
  const days = Number.isNaN(t) ? 0 : Math.max(0, (now - t) / 86400000)
  const decay = Math.exp((-Math.LN2 * days) / HALF_LIFE_DAYS)
  return (Math.log(1 + n) / Math.log(1 + N_CAP)) * decay
}

/** 记一次引用；间隔守卫挡掉同半天的重复。返回是否真的记了。 */
export function bump(data, lib, id, now) {
  if (!data || !data.entries) return false
  const key = lib + '/' + id
  const iso = new Date(now).toISOString()
  const e = data.entries[key]
  if (e) {
    const last = Date.parse(e.last)
    if (!Number.isNaN(last) && now - last < SAME_DAY_MS) return false
    e.n = (Number(e.n) || 0) + 1
    e.last = iso
    return true
  }
  data.entries[key] = { n: 1, first: iso, last: iso }
  return true
}

/** 只留最近用过的 MAX_ENTRIES 条，防止文件无限长。 */
export function prune(data, keep = MAX_ENTRIES) {
  if (!data || !data.entries) return
  const keys = Object.keys(data.entries)
  if (keys.length <= keep) return
  keys.sort((a, b) => (Date.parse(data.entries[b].last) || 0) - (Date.parse(data.entries[a].last) || 0))
  for (const k of keys.slice(keep)) delete data.entries[k]
}
