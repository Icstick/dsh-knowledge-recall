// test/scheduler-metering.test.mjs — 注入调度器接线（2026-10-04 · 审计 P1 修复）。
//
// 背景：本插件此前真在注入却从未注册到 dsh-inject-scheduler ⇒ 它的 token 不进任何
// 配额核算，conflictPolicy / census 也看不见它。本文件钉住接线后的契约：
//   ① 段参数契约（key/plugin/order/budget/unit/refresh）；
//   ② 调度器是**可选**依赖 —— 缺失/故障一律 fail-open，绝不阻断注入与 turn；
//   ③ 上报量 = 真正 push 进 decision 的那段文本（字符级精确）；
//   ④ 接线守卫：注入点确实调用了上报（模块级测试覆盖不到"调用漏插"，见 ACP M5 教训）。
//
// 隔离：apply 会读 $DSH_HOME（memory-strength.json）与默认知识库目录，这里把 DSH_HOME
// 指到临时目录、dbDir 指到夹具目录，不碰真实 weaver 库与记忆强度文件。
//
// 跑法：node --test test/*.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  apply,
  KR_SECTION_KEY,
  KR_SECTION_ORDER,
  registerRecallSection,
  reportRecallUsage,
} from '../src/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = mkdtempSync(join(tmpdir(), 'kr-sched-home-'))
process.env.DSH_HOME = HOME
after(() => { rmSync(HOME, { recursive: true, force: true }) })

const LIB = 'work-skill'
const FIXTURE_TERM = '调度器记账接线'

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kr-sched-db-'))
  const db = new DatabaseSync(join(dir, LIB + '.db'))
  db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT, summary TEXT, body TEXT, source TEXT, tags TEXT, confidence REAL, created_at TEXT, updated_at TEXT)')
  db.prepare('INSERT INTO entries (id,title,summary,body,source,tags,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('wv-sched', FIXTURE_TERM, '段注册与用量上报', 'body', '', '[]', 0.9, '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z')
  db.close()
  return dir
}
const FIXTURE_DIR = makeFixture()
after(() => { rmSync(FIXTURE_DIR, { recursive: true, force: true }) })

// ---- mock 面（形态对照 dsh-adaptive-context/test/scheduler-metering.test.mjs）----

/** mock ctx：get 读 services + on 收集订阅（'agent/pre-step' 与 'internal/service' 分开收）。 */
function mockCtx(services = {}) {
  const listeners = {}
  const warns = []
  const ctx = {
    get: (name) => services[name] ?? undefined,
    inject(_deps, cb) { try { cb({}) } catch { /* settings 缺失：无关本次断言 */ } },
    on(name, cb) { (listeners[name] ??= []).push(cb); return () => {} },
    logger: {
      warn: (...a) => warns.push(a.map(String).join(' ')),
      info: (...a) => warns.push('[info] ' + a.map(String).join(' ')),
    },
    __listeners: listeners,
    __warns: warns,
  }
  return ctx
}

/** fake scheduler：收集 registerSection/recordUsage 调用。 */
function fakeScheduler(overrides = {}) {
  const calls = { sections: [], usage: [] }
  return {
    calls,
    registerSection: async (input) => { calls.sections.push(input); return { ok: true, key: input.key } },
    recordUsage: async (input) => { calls.usage.push(input); return { ok: true, key: 'k', total: input.injectedChars, count: 1 } },
    ...overrides,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 5))

// ---- ① 段参数契约 ----

test('段参数契约：kr.recall / order 30 / tokens / budget = maxTokensPerTurn', () => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  registerRecallSection(ctx, { maxTokensPerTurn: 400 })
  assert.equal(sched.calls.sections.length, 1)
  assert.deepEqual(sched.calls.sections[0], {
    key: KR_SECTION_KEY,
    plugin: 'dsh-knowledge-recall',
    order: KR_SECTION_ORDER,
    budgetChars: 400,
    unit: 'tokens',
    refresh: 'per-turn',
  })
})

test('段 key/order 与既有段不撞（acp.composer=10 / wc.work_state=20）', () => {
  assert.equal(KR_SECTION_KEY, 'kr.recall')
  assert.match(KR_SECTION_KEY, /^[a-z][a-z0-9_.-]{0,63}$/)          // 调度器 SECTION_KEY_RE
  assert.equal(KR_SECTION_ORDER, 30)
  assert.ok(KR_SECTION_ORDER > 20 && KR_SECTION_ORDER < 100, '落在 context 带（0<order<100）')
})

test('段参数契约：缺省 maxTokensPerTurn → 400（Config 默认）', () => {
  const sched = fakeScheduler()
  registerRecallSection(mockCtx({ injectScheduler: sched }), {})
  assert.equal(sched.calls.sections[0].budgetChars, 400)
})

// ---- ② 就绪时序与 fail-open ----

test('scheduler 未就绪 → 订阅 internal/service，就绪事件到达后注册', () => {
  const services = {}
  const ctx = mockCtx(services)
  registerRecallSection(ctx, { maxTokensPerTurn: 400 })
  assert.equal((ctx.__listeners['internal/service'] ?? []).length, 1, '应订阅 internal/service')
  // 模拟 dsh-inject-scheduler 稍后装载（本插件在 bundles 里排在它之前）
  const sched = fakeScheduler()
  services.injectScheduler = sched
  ctx.__listeners['internal/service'][0]('injectScheduler')
  assert.equal(sched.calls.sections.length, 1, '就绪事件后应完成注册')
  assert.equal(sched.calls.sections[0].key, KR_SECTION_KEY)
})

test('scheduler 从未出现 → 静默（不抛、无注册）', () => {
  assert.doesNotThrow(() => registerRecallSection(mockCtx({}), {}))
})

test('注册被拒（conflictPolicy=reject）→ 出声 warn，不静默', async () => {
  const sched = fakeScheduler({
    registerSection: async () => ({ ok: false, error: 'order-conflict', message: 'clashes with x' }),
  })
  const ctx = mockCtx({ injectScheduler: sched })
  registerRecallSection(ctx, {})
  await flush()
  assert.equal(ctx.__warns.length, 1)
  assert.match(ctx.__warns[0], /register rejected/)
})

test('registerSection 抛错 → 降级 warn，不抛（fail-open）', async () => {
  const sched = fakeScheduler({ registerSection: async () => { throw new Error('storage down') } })
  const ctx = mockCtx({ injectScheduler: sched })
  assert.doesNotThrow(() => registerRecallSection(ctx, {}))
  await flush()
  assert.match(ctx.__warns[0], /section register failed/)
})

// ---- ③ 上报量 ----

test('上报：注入后记实际字符数（body.length）', async () => {
  const sched = fakeScheduler()
  reportRecallUsage(mockCtx({ injectScheduler: sched }), 'session-1', '内容 A')
  await flush()
  assert.deepEqual(sched.calls.usage[0], {
    sessionId: 'session-1',
    section: KR_SECTION_KEY,
    injectedChars: '内容 A'.length,
  })
})

test('上报：空 sessionId → 不传 sessionId（落 global 槽）', async () => {
  const sched = fakeScheduler()
  reportRecallUsage(mockCtx({ injectScheduler: sched }), '', '无会话上下文')
  await flush()
  const call = sched.calls.usage[0]
  assert.equal(Object.hasOwn(call, 'sessionId'), false)
  assert.equal(call.injectedChars, '无会话上下文'.length)
})

test('上报：空 body / 非字符串 → 不报', async () => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  reportRecallUsage(ctx, 'session-1', '')
  reportRecallUsage(ctx, 'session-1', null)
  reportRecallUsage(ctx, 'session-1', undefined)
  await flush()
  assert.equal(sched.calls.usage.length, 0)
})

test('上报：scheduler 缺失 / recordUsage 抛错 → 静默降级（不阻断）', async () => {
  assert.doesNotThrow(() => reportRecallUsage(mockCtx({}), 'session-1', '有内容'))
  const sched = fakeScheduler({ recordUsage: async () => { throw new Error('storage down') } })
  const ctx = mockCtx({ injectScheduler: sched })
  assert.doesNotThrow(() => reportRecallUsage(ctx, 'session-1', '内容'))
  await flush()
})

// ---- ④ 端到端：apply → pre-step 注入 → 上报（不是只测模块函数）----

function mount(config) {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  apply(ctx, config)
  const handlers = ctx.__listeners['agent/pre-step'] ?? []
  assert.equal(handlers.length, 1, 'apply 应恰好注册一个 agent/pre-step listener')
  return { ctx, sched, handler: handlers[0] }
}

const realUser = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const payload = (sessionId = 'sess-kr') => ({ step: 1, agent: { session: { id: sessionId }, delegationDepth: 0 } })

test('端到端：命中注入一帧 → 调度器收到同字符数的 kr.recall 用量；注册也已完成', async () => {
  const { sched, handler } = mount({ dbDir: FIXTURE_DIR, libs: [LIB], minScore: 3, maxTokensPerTurn: 400 })
  // apply 时 scheduler 已就绪 → 立即注册
  await flush()
  assert.equal(sched.calls.sections.length, 1, 'apply 即注册段')
  assert.equal(sched.calls.sections[0].key, KR_SECTION_KEY)

  const decision = { kind: 'enter', messages: [realUser(FIXTURE_TERM)] }
  const result = await handler(payload('sess-e2e'), async () => decision)
  assert.equal(result.messages.length, 2, '命中应注入一条')

  await flush()
  assert.equal(sched.calls.usage.length, 1, '注入一次应上报一次')
  const call = sched.calls.usage[0]
  assert.equal(call.section, KR_SECTION_KEY)
  assert.equal(call.sessionId, 'sess-e2e')
  // 上报量 = 真正 push 进去的那段文本（不是估算、不是预算上限）
  const injectedText = result.messages[1].content[0].text
  assert.equal(call.injectedChars, injectedText.length)
  assert.ok(call.injectedChars > 0)
})

test('端到端：零命中（空库）→ 不注入也不上报（零 token 不落账）', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'kr-sched-empty-'))
  after(() => { rmSync(empty, { recursive: true, force: true }) })
  const { sched, handler } = mount({ dbDir: empty, libs: [LIB], minScore: 3 })
  const decision = { kind: 'enter', messages: [realUser(FIXTURE_TERM)] }
  const result = await handler(payload('sess-empty'), async () => decision)
  assert.equal(result.messages.length, 1, '空库不注入')
  await flush()
  assert.equal(sched.calls.usage.length, 0, '没有注入就不应有记账')
})

test('端到端：scheduler 缺失 → 注入照常（可选依赖不阻断）', async () => {
  const ctx = mockCtx({})
  apply(ctx, { dbDir: FIXTURE_DIR, libs: [LIB], minScore: 3, maxTokensPerTurn: 400 })
  const handler = ctx.__listeners['agent/pre-step'][0]
  const decision = { kind: 'enter', messages: [realUser(FIXTURE_TERM)] }
  const result = await handler(payload('sess-nosched'), async () => decision)
  assert.equal(result.messages.length, 2, '调度器缺席也必须照常注入')
  await flush()
  assert.equal(ctx.__warns.length, 0, '可选依赖缺席不算错误，不该刷 warn')
})

// ---- 接线守卫（源码级：模块级测试覆盖不到"调用漏插"，见 ACP M5 教训）----

test('接线守卫：pre-step 注入点存在 reportRecallUsage 调用（非定义行）', () => {
  const src = readFileSync(join(HERE, '../src/index.mjs'), 'utf8')
  const lines = src.split(/\r?\n/)
  const defLine = lines.findIndex((l) => /^export function reportRecallUsage\s*\(/.test(l))
  assert.ok(defLine >= 0, 'reportRecallUsage 应导出（测试与消费方共用）')
  const pushLine = lines.findIndex((l) => l.includes('decision.messages.push(createUserMessage('))
  assert.ok(pushLine >= 0, '注入点（push）应存在')
  // 注入点之后 12 行内必须有调用，且不能是定义行本身
  const callLine = lines.findIndex((l, i) => i > pushLine && i <= pushLine + 12
    && /reportRecallUsage\(/.test(l) && !/^export function/.test(l))
  assert.ok(callLine > pushLine, '注入点之后必须调用 reportRecallUsage（否则测试全绿而接线从未发生）')
})

test('接线守卫：apply 里注册了段（registerRecallSection 调用，非定义行）', () => {
  const src = readFileSync(join(HERE, '../src/index.mjs'), 'utf8')
  const lines = src.split(/\r?\n/)
  const inApply = lines.findIndex((l) => /^export function apply\s*\(/.test(l))
  assert.ok(inApply >= 0)
  const callLine = lines.findIndex((l, i) => i > inApply && /^\s*registerRecallSection\(ctx,/.test(l))
  assert.ok(callLine > inApply, 'apply 必须调用 registerRecallSection')
})
