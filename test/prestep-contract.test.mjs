// test/prestep-contract.test.mjs — agent/pre-step 交付契约护栏（P1 · 2026-10-02）
//
// 钉住什么：本插件的 listener 挂在 cordis waterfall `agent/pre-step` 上。上游语义
// （D:/deepseek-harness/vendor/cordis/src/events.ts:225-243）：
//   · 每条 listener 拿到 (payload, next)；**不调 next() 就是否决**（下游与本链的内建行为都不跑）；
//   · 整条链的返回值 = 最外层 listener 的返回值 —— 旁观者返回 undefined，调用方拿到的就是非法决策。
//
// 护栏三条（每个分支都过一遍）：① 返回值要么是合法 PreStepDecision，要么是 next() 返回值原样；
// ② 每次调用都调过 next()；③ 注入路径任何故障只降级日志、不抛（fail-open；本仓 AGENTS.md）。
//
// 覆盖的 return 分支（src/index.mjs:117-191 逐行对）：未启用 / step≠1 / 决策非 enter /
// 无真实用户消息 / 预算为 0（含子代理减半后为 0）/ 合计护栏剩余字符为 0 / 关键词为空 /
// 库里无命中 / 节流命中 / 格式化成空文本 / 正常注入 / catch 降级。
//
// 隔离：apply 时会读 $DSH_HOME（memory-strength.json）与默认知识库目录，这里把 DSH_HOME
// 指到临时目录、dbDir 指到测试夹具目录，不碰真实 weaver 库与记忆强度文件。
//
// 跑法：node --test test/*.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../src/index.mjs'

const HOME = mkdtempSync(join(tmpdir(), 'kr-guard-home-'))
process.env.DSH_HOME = HOME
after(() => { rmSync(HOME, { recursive: true, force: true }) })

const LIB = 'work-skill'
// 命中分数：title 命中 = 3（search.mjs 的加权），测试里显式 minScore=3，不靠默认阈值碰运气。
const FIXTURE_TERM = '事件纪律护栏'

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kr-guard-db-'))
  const db = new DatabaseSync(join(dir, LIB + '.db'))
  db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT, summary TEXT, body TEXT, source TEXT, tags TEXT, confidence REAL, created_at TEXT, updated_at TEXT)')
  db.prepare('INSERT INTO entries (id,title,summary,body,source,tags,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('wv-guard', FIXTURE_TERM, 'waterfall 契约与合法决策', 'body', '', '[]', 0.9, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')
  db.close()
  return dir
}
const FIXTURE_DIR = makeFixture()
const EMPTY_DIR = mkdtempSync(join(tmpdir(), 'kr-guard-empty-'))
after(() => { rmSync(FIXTURE_DIR, { recursive: true, force: true }); rmSync(EMPTY_DIR, { recursive: true, force: true }) })

// ---- 与仓内既有用例同款的最小 ctx（对照 dsh-work-continuity/test/work.test.mjs 的 mockCtx）----

function mockCtx() {
  const listeners = {}
  const warns = []
  return {
    get() { return undefined },
    inject(_deps, cb) { try { cb({}) } catch { /* settings 缺失：无关本次断言 */ } },
    on(name, cb) { (listeners[name] ??= []).push(cb); return () => {} },
    logger: { warn: (...a) => warns.push(a.map(String).join(' ')) },
    __listeners: listeners,
    __warns: warns,
  }
}

function mount(config) {
  const ctx = mockCtx()
  apply(ctx, config)
  const handlers = ctx.__listeners['agent/pre-step'] ?? []
  assert.equal(handlers.length, 1, 'apply 应恰好注册一个 agent/pre-step listener')
  return { ctx, handler: handlers[0] }
}

// ---- 构造器 ----

const realUser = (text = '你好，聊聊天气') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const pluginMsg = (text, plugin = 'dsh-adaptive-context') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } })
const enter = (...messages) => ({ kind: 'enter', messages })
const reject = () => ({ kind: 'reject', reason: 'test' })
const payload = ({ step = 1, sessionId = 'sess-kr', delegationDepth = 0 } = {}) =>
  ({ step, agent: { session: { id: sessionId }, delegationDepth } })

function isLegalDecision(v) {
  if (v === null || typeof v !== 'object') return false
  if (v.kind === 'reject') return true
  return v.kind === 'enter' && Array.isArray(v.messages)
}

/** 每个分支都过这一遍：调用计数、合法返回值、原样透传。 */
async function callGuard(handler, pl, next) {
  let nextCalls = 0
  const countingNext = async (...args) => { nextCalls += 1; return next(...args) }
  const result = await handler(pl, countingNext)
  assert.equal(nextCalls, 1, '每次调用必须调过 next()（旁观者不得否决下游）')
  // 严格：next() 已给出合法决策时，返回值必须还是合法决策。
  // 这里**不能**放行 undefined —— 漏写 return next() 与「下游本来就返回 undefined」
  // 在返回值上长得一样，一旦放行，最危险的那条坏法（漏 return）就被护栏自己放过。
  // 「下游返回 undefined / 抛错」两种边界另有专门用例，不走本助手。
  assert.ok(isLegalDecision(result), '返回值必须是合法 PreStepDecision；实收=' + JSON.stringify(result))
  return result
}

const BASE = { dbDir: EMPTY_DIR, libs: [LIB] }

// ---- 用例：每个 return 路径 ----

test('未启用（enabled=false）：原样透传，不检索', { }, async () => {
  const { handler } = mount({ ...BASE, enabled: false })
  const decision = enter(realUser())
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 1)
})

test('step≠1：原样透传', async () => {
  const { handler } = mount(BASE)
  const decision = enter(realUser())
  const result = await callGuard(handler, payload({ step: 3 }), async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 1)
})

test('决策非 enter（reject）：原样透传', async () => {
  const { handler } = mount(BASE)
  const decision = reject()
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision)
})

test('下游返回 undefined：原样透传（链已断，本插件不制造也不掩盖）', async () => {
  const { handler } = mount(BASE)
  let nextCalls = 0
  // 不走 callGuard：那条助手的判据是「next 给了合法决策 → 返回也得合法」，
  // 这条是另一回事——下游自己就断了链，本插件只做透传。
  const result = await handler(payload(), async () => { nextCalls += 1; return undefined })
  assert.equal(nextCalls, 1, '仍然调过 next()')
  assert.equal(result, undefined, '透传下游的返回值')
})

test('决策里没有真实用户消息（只有插件注入）：不检索', async () => {
  const { handler } = mount(BASE)
  const decision = enter(pluginMsg('[acp] 上下文'))
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 1)
})

test('预算为 0：显式 0 与「子代理减半后为 0」两条都原样透传', async () => {
  const a = mount({ ...BASE, maxTokensPerTurn: 0 })
  const d1 = enter(realUser(FIXTURE_TERM))
  assert.equal(await callGuard(a.handler, payload(), async () => d1), d1)
  assert.equal(d1.messages.length, 1, '预算 0 不注入')

  // 子代理：budgetTokens = floor(1 * 0.5) = 0
  const b = mount({ ...BASE, maxTokensPerTurn: 1, maxHits: 1 })
  const d2 = enter(realUser(FIXTURE_TERM))
  assert.equal(await callGuard(b.handler, payload({ delegationDepth: 1 }), async () => d2), d2)
  assert.equal(d2.messages.length, 1, '子代理预算减半后为 0 → 不注入')
})

test('合计护栏：既有插件注入已吃满 1800 字符 → 剩余为 0，不注入', async () => {
  const { handler } = mount({ ...BASE, dbDir: FIXTURE_DIR, minScore: 3 })
  const decision = enter(pluginMsg('x'.repeat(1800)), realUser(FIXTURE_TERM))
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 2, '合计护栏拦住时不得追加')
})

test('关键词为空（纯语气词）：不检索', async () => {
  const { handler } = mount({ ...BASE, dbDir: FIXTURE_DIR, minScore: 3 })
  const decision = enter(realUser('好的'))
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 1)
})

test('知识库无命中（空目录）：不注入', async () => {
  const { handler } = mount(BASE)
  const decision = enter(realUser(FIXTURE_TERM))
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 1)
})

test('命中但预算小到装不下一行：formatHits 返回空文本 → 不注入', async () => {
  const { handler } = mount({ ...BASE, dbDir: FIXTURE_DIR, minScore: 3, maxTokensPerTurn: 1 })
  const decision = enter(realUser(FIXTURE_TERM))
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 1, '预算 1 token（2 字符）装不下一行 → 不注入')
})

test('命中：追加一条带 source 标记的插件消息', async () => {
  const { handler } = mount({ ...BASE, dbDir: FIXTURE_DIR, minScore: 3, maxTokensPerTurn: 400 })
  const decision = enter(realUser(FIXTURE_TERM))
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision)
  assert.equal(result.messages.length, 2, '命中恰好注入一条')
  const pushed = result.messages[1]
  assert.equal(pushed.role, 'user')
  // 现状记录（不是推荐形态）：本仓用 kind:'plugin:<name>'，没有 plugin 字段——
  // 与 time-ink/work-continuity 的 {kind:'plugin', plugin} 不同族。交叉影响见 P1 报告
  // 「inject-scheduler 的 census 只看 kind==='plugin'，因此看不见本仓的注入」。
  assert.deepEqual(pushed.source, { kind: 'plugin:dsh-knowledge-recall' })
  assert.match(pushed.content[0].text, /^\[knowledge-recall\] weaver work-skill\/wv-guard/)
})

test('同会话同命中集合：节流不重复注入', async () => {
  const { handler } = mount({ ...BASE, dbDir: FIXTURE_DIR, minScore: 3, maxTokensPerTurn: 400 })
  const decision = enter(realUser(FIXTURE_TERM))
  await callGuard(handler, payload(), async () => decision)
  assert.equal(decision.messages.length, 2, '第一次命中注入')
  await callGuard(handler, payload(), async () => decision)
  assert.equal(decision.messages.length, 2, '同命中集合第二次被 RecallThrottle 拦住')
})

test('注入路径抛错：降级日志 + 返回原决策（fail-open）', async () => {
  const { ctx, handler } = mount(BASE)
  const messages = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'some') throw new Error('recall boom')
      return Reflect.get(target, key, receiver)
    },
  })
  const decision = { kind: 'enter', messages }
  const result = await callGuard(handler, payload(), async () => decision)
  assert.equal(result, decision, '故障只降级，不阻断回合')
  assert.ok(ctx.__warns.some((w) => w.includes('[knowledge-recall] inject degraded')), '降级日志应含 [knowledge-recall] inject degraded；实收=' + JSON.stringify(ctx.__warns))
})

test('下游抛错：向上传播，不吞（fail-open 的边界）', async () => {
  const { handler } = mount(BASE)
  await assert.rejects(
    () => handler(payload(), async () => { throw new Error('downstream boom') }),
    /downstream boom/,
    'next() 在 try 之外 —— 下游故障照常传播',
  )
})
