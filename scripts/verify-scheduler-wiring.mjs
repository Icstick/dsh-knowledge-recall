// scripts/verify-scheduler-wiring.mjs — 重启后判据：kr.recall 是否真的进了注入调度器。
//
// 为什么需要它：inject-scheduler 的服务只在宿主进程内可达，没有 IPC；插件源码改动也要重启
// 才生效。宿主把 domain 落在磁盘上（<DSH_HOME>/storages/inject_scheduler.json），那是唯一
// 可从进程外读到、且可复跑的判据。
//
// 判定两条：
//   ① 段注册：sections 里有 kr.recall（plugin=dsh-knowledge-recall / order=30 / unit=tokens）
//   ② 用量记账：usage 里有 section=kr.recall 的行，且 injectedChars 合计 > 0
// 两条都过 = 接线生效。①过②不过 = 段注册了但重启后还没发生过召回（不一定是故障）。
//
// 零依赖（node:fs / node:path），只读，不改任何文件。
//
// 跑法：
//   node scripts/verify-scheduler-wiring.mjs                 # 严格：两条都要过
//   node scripts/verify-scheduler-wiring.mjs --allow-empty   # 只查段注册
//   node scripts/verify-scheduler-wiring.mjs --file <path>   # 指定 store 文件
//
// 退出码：通过 = 0；不通过 = 1（失败大声失败，不静默降级）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const allowEmpty = argv.includes('--allow-empty')
const fileArg = argv.indexOf('--file')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const storePath = fileArg >= 0 ? argv[fileArg + 1] : join(dshHome, 'storages', 'inject_scheduler.json')

const SECTION = 'kr.recall'
let raw
try {
  raw = JSON.parse(readFileSync(storePath, 'utf8'))
} catch (err) {
  console.error('FAIL  读不到调度器 store：' + storePath)
  console.error('      ' + (err instanceof Error ? err.message : String(err)))
  console.error('      宿主没启动过 / 路径不对 / JSON 损坏——都没有"看起来应该是这样"的余地，就此停下。')
  process.exit(1)
}

const sections = raw?.tables?.sections ?? {}
const usage = raw?.tables?.usage ?? {}
const section = sections[SECTION]
const rows = Object.values(usage).filter((r) => r && r.section === SECTION)
const chars = rows.reduce((n, r) => n + (Number(r.injectedChars) || 0), 0)
const count = rows.reduce((n, r) => n + (Number(r.count) || 0), 0)
const sessions = new Set(rows.map((r) => r.sessionId))
const dates = [...new Set(rows.map((r) => r.date))].sort()

console.log('store      : ' + storePath)
console.log('已注册段   : ' + Object.keys(sections).sort().join(', '))
console.log('')

let ok = true

console.log('① 段注册 ' + SECTION)
if (section) {
  console.log('   PASS  ' + JSON.stringify(section))
  const good = section.plugin === 'dsh-knowledge-recall' && section.order === 30
    && section.unit === 'tokens' && section.budgetChars > 0 && section.refresh === 'per-turn'
  if (!good) { ok = false; console.log('   FAIL  段参数与契约不符（期望 plugin=dsh-knowledge-recall / order=30 / unit=tokens / budget>0 / refresh=per-turn）') }
} else {
  ok = false
  console.log('   FAIL  没有 kr.recall 段 —— 接线没生效。')
  console.log('         排查顺序：宿主重启了吗 → dsh-inject-scheduler 装载了吗（profile bundles）')
  console.log('         → 启动日志里有没有 [knowledge-recall] section register failed / rejected')
}

console.log('')
console.log('② 用量记账 ' + SECTION)
if (rows.length === 0) {
  if (allowEmpty) {
    console.log('   SKIP  重启以来还没有 kr.recall 的记账（--allow-empty 下不算失败）')
  } else {
    ok = false
    console.log('   FAIL  没有任何 ' + SECTION + ' 的用量行。')
    console.log('         若刚重启还没发生过「命中即注入」，加 --allow-empty 再跑一次；')
    console.log('         若已注入过仍为空，记账调用没接上（看 test/scheduler-metering.test.mjs 的接线守卫）。')
  }
} else {
  console.log('   PASS  行数=' + rows.length + '  笔数=' + count + '  合计字符=' + chars
    + '  会话数=' + sessions.size + '  日期=' + dates.join(','))
  const newest = rows.reduce((a, b) => ((a?.updatedAt ?? 0) > (b?.updatedAt ?? 0) ? a : b))
  console.log('   最近一笔: ' + new Date(newest.updatedAt).toISOString()
    + '  injectedChars=' + newest.injectedChars + '  session=' + newest.sessionId)
  console.log('   按口径估算 ≈ ' + Math.round(chars / 2) + ' tokens（本插件 CHARS_PER_TOKEN=2；'
    + '调度器 getSessionReport 另用 charPerToken=1.5，两者口径不同，见报告）')
}

console.log('')
console.log(ok ? 'ALL GREEN' : 'NOT WIRED')
process.exit(ok ? 0 : 1)
