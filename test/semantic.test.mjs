// test/semantic.test.mjs — 语义补充路径（2026-10-13 自云端 C 收回）
//
// 钉住什么：
//   ① 关键词命中不足时补一条向量路径，语义命中能进注入文本（mergeHits 顺序与去重）；
//   ② fail-open：服务不可达 / 超时 / 返回异常一律降级成空数组，不抛、不阻断回合；
//   ③ **默认不发请求**：semantic=false（本仓默认）时一个包都不发（计数挂在 globalThis.fetch 上，
//      与 endpoint 配成什么无关 —— 配置被忽略也逃不掉）；
//   ④ semanticFallbackBelow 的「<」边界（below=3 发、below=2 不发 ⇒ 关键词命中恰为 2）；
//   ⑤ 宿主纪律：search.mjs 取向量只认 endpoint 字符串，不出现 ctx 访问。
//
// 隔离：全用 127.0.0.1 上 listen(0) 的临时假服务，**永不依赖真 8765 是否在线**；
// DSH_HOME 指到临时目录，知识库用临时夹具库，不碰生产 weaver-kb 与记忆强度文件。
//
// 跑法：node --test test/*.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../src/index.mjs'
import { semanticSearch, ALL_LIBS } from '../src/search.mjs'
import { extractKeywords } from '../src/recall.mjs'

const HOME = mkdtempSync(join(tmpdir(), 'kr-sem-home-'))
process.env.DSH_HOME = HOME
const EMPTY_DIR = mkdtempSync(join(tmpdir(), 'kr-sem-empty-'))
after(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(EMPTY_DIR, { recursive: true, force: true }) })

// ---- 假服务（listen 0 → 临时端口）----

/** handler(req, res, state)；requests 记录每条 URL，用来断言「发了几次 / 发没发」。 */
async function withMock(handler, fn) {
  const state = { requests: [] }
  const server = createServer((req, res) => {
    state.requests.push(req.url)
    handler(req, res, state)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + server.address().port
  try {
    return await fn({ endpoint, state })
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

function jsonReply(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

/** 与线上 C 侧 8765 同形（2026-10-13 实测）：{ok, tookMs, hits:[{lib,id,title,summary,tags,score,confidence,updatedAt}]} */
const replyHits = (hits) => (req, res) => jsonReply(res, { ok: true, tookMs: 1.2, hits })

const SEM_HIT = {
  lib: 'work-skill', id: 'wv-sem-1', title: '语义命中的条目',
  summary: '这条只能靠向量召回拿到', tags: '[]',
  score: 0.8, confidence: 0.9, updatedAt: '2026-10-01T00:00:00.000Z',
}

// ---- 与 prestep-contract.test.mjs 同款最小 ctx ----

function mockCtx() {
  const listeners = {}
  const warns = []
  return {
    get() { return undefined },
    inject(_deps, cb) { try { cb({}) } catch { /* settings 缺失：无关本次断言 */ } },
    on(name, cb) { (listeners[name] ??= []).push(cb); return () => {} },
    logger: { warn: (...a) => warns.push(a.map(String).join(' ')), debug: () => {} },
    __listeners: listeners,
    __warns: warns,
  }
}

async function mount(config) {
  const ctx = mockCtx()
  apply(ctx, config)
  const handlers = ctx.__listeners['agent/pre-step'] ?? []
  assert.equal(handlers.length, 1, 'apply 应恰好注册一个 agent/pre-step listener')
  return { ctx, handler: handlers[0] }
}

const realUser = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const enter = (...messages) => ({ kind: 'enter', messages })
const payload = ({ step = 1, sessionId = 'sess-sem', delegationDepth = 0 } = {}) =>
  ({ step, agent: { session: { id: sessionId }, delegationDepth } })
const run = (handler, decision) => handler(payload(), async () => decision)

const QUERY = '昨天那个检索的坑'   // 抽得出词，但空库里零命中 → 命中数 0 < 阈值 → 走语义

// ---- ① 语义命中：能进注入文本 ----

test('语义命中：关键词零命中时补一路，命中进注入文本', async () => {
  await withMock(replyHits([SEM_HIT]), async ({ endpoint, state }) => {
    const { handler } = await mount({
      dbDir: EMPTY_DIR, libs: ['work-skill'], minScore: 3,
      semantic: true, semanticEndpoint: endpoint,
    })
    const decision = enter(realUser(QUERY))
    const result = await run(handler, decision)

    assert.equal(state.requests.length, 1, '恰好发一次语义请求')
    const url = new URL(state.requests[0], endpoint)
    assert.equal(url.pathname, '/search')
    assert.equal(url.searchParams.get('q'), QUERY, '整句原样送过去，不抽词')
    assert.equal(url.searchParams.get('libs'), 'work-skill', 'libs 按配置收窄')
    assert.equal(url.searchParams.get('min'), '0.42', 'Config.semanticMinScore 默认 0.42')

    assert.equal(result.messages.length, 2, '语义命中应注入一条')
    const text = result.messages[1].content[0].text
    assert.match(text, /\[knowledge-recall\]/)
    assert.match(text, /weaver work-skill\/wv-sem-1/, '注入条目来自语义路径')
    assert.match(text, /语义命中的条目/)
    assert.equal(result.messages[1].source.kind, 'plugin:dsh-knowledge-recall')
  })
})

test('语义命中：maxHits 收窄送给服务的 k（不是硬编码 8）', async () => {
  await withMock(replyHits([SEM_HIT]), async ({ endpoint, state }) => {
    const { handler } = await mount({
      dbDir: EMPTY_DIR, libs: ['work-skill'], minScore: 3, maxHits: 2,
      semantic: true, semanticEndpoint: endpoint,
    })
    await run(handler, enter(realUser(QUERY)))
    assert.equal(new URL(state.requests[0], endpoint).searchParams.get('k'), '4',
      '首回合 openingScan 放宽到 max(4, maxHits)=4')
  })
})

// ---- ② 服务不可达 / 返回异常：降级，不抛 ----

test('服务不可达（端口没人听）：只 warn 降级，不注入、不抛、原决策原样返回', async () => {
  const { ctx, handler } = await mount({
    dbDir: EMPTY_DIR, libs: ['work-skill'], minScore: 3,
    semantic: true, semanticEndpoint: 'http://127.0.0.1:1', semanticTimeoutMs: 300,
  })
  const decision = enter(realUser(QUERY))
  const result = await run(handler, decision)

  assert.equal(result, decision, '返回原决策对象（fail-open）')
  assert.equal(result.messages.length, 1, '降级后不注入')
  assert.ok(ctx.__warns.some((w) => w.includes('semantic degraded')),
    '服务不可达要出声（只 warn，不抛）；实收=' + JSON.stringify(ctx.__warns))
})

test('服务返回 ok:false / HTTP 500 / 非 JSON：一律空数组，不抛', async () => {
  const cases = [
    ['ok:false', (req, res) => jsonReply(res, { ok: false, error: 'boom' })],
    ['HTTP 500', (req, res) => jsonReply(res, { ok: true, hits: [SEM_HIT] }, 500)],
    ['非 JSON', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not json') }],
    ['hits 不是数组', (req, res) => jsonReply(res, { ok: true, hits: { nope: 1 } })],
  ]
  for (const [label, handler] of cases) {
    await withMock(handler, async ({ endpoint, state }) => {
      const out = await semanticSearch(QUERY, { endpoint, timeoutMs: 300 })
      assert.deepEqual(out, [], label + '：应返回空数组')
      assert.equal(state.requests.length, 1, label + '：请求确实发出去了（是「降级」不是「没发」）')
    })
  }
})

test('超时：semanticTimeoutMs 到点即放弃，返回空数组并回调 onWarn', async () => {
  await withMock(() => { /* 故意不回，挂住 */ }, async ({ endpoint }) => {
    const warns = []
    const t0 = Date.now()
    const out = await semanticSearch(QUERY, { endpoint, timeoutMs: 80, onWarn: (e) => warns.push(e) })
    const dt = Date.now() - t0
    assert.deepEqual(out, [])
    assert.equal(warns.length, 1, '超时要走 onWarn')
    assert.ok(dt < 3000, '不得挂死；实测 ' + dt + 'ms')
  })
})

test('空查询：不发请求直接返回空数组', async () => {
  await withMock(replyHits([SEM_HIT]), async ({ endpoint, state }) => {
    assert.deepEqual(await semanticSearch('   ', { endpoint }), [])
    assert.equal(state.requests.length, 0)
  })
})

// ---- ③ 默认关：semantic=false 时一个包都不发 ----

test('semantic:false（本仓默认）：完全不发请求 —— 计数挂在 globalThis.fetch 上，换 endpoint 也逃不掉', async () => {
  await withMock(replyHits([SEM_HIT]), async ({ endpoint, state }) => {
    const orig = globalThis.fetch
    let calls = 0
    globalThis.fetch = (...args) => { calls += 1; return orig(...args) }
    try {
      const { handler } = await mount({
        dbDir: EMPTY_DIR, libs: ['work-skill'], minScore: 3,
        semantic: false, semanticEndpoint: endpoint,
      })
      const decision = enter(realUser(QUERY))
      const result = await run(handler, decision)
      assert.equal(calls, 0, 'semantic=false 时不得有任何 fetch 调用')
      assert.equal(state.requests.length, 0, '假服务一个请求都不该收到')
      assert.equal(result.messages.length, 1, '零命中 → 不注入')
    } finally { globalThis.fetch = orig }
  })
})

test('不传 semantic（走 Config 默认）：同样不发请求（默认关的回归位）', async () => {
  await withMock(replyHits([SEM_HIT]), async ({ endpoint, state }) => {
    const orig = globalThis.fetch
    let calls = 0
    globalThis.fetch = (...args) => { calls += 1; return orig(...args) }
    try {
      const { handler } = await mount({ dbDir: EMPTY_DIR, libs: ['work-skill'], minScore: 3, semanticEndpoint: endpoint })
      await run(handler, enter(realUser(QUERY)))
      assert.equal(calls, 0, '未显式开启时不得发请求')
      assert.equal(state.requests.length, 0)
    } finally { globalThis.fetch = orig }
  })
})

// ---- ④ semanticFallbackBelow 的「<」边界 ----

const FIX_LIB = 'work-skill'
const TWO_HIT_TERM = '备份清理'
function makeTwoHitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kr-sem-db-'))
  const db = new DatabaseSync(join(dir, FIX_LIB + '.db'))
  db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT, summary TEXT, body TEXT, source TEXT, tags TEXT, confidence REAL, created_at TEXT, updated_at TEXT)')
  const ins = db.prepare('INSERT INTO entries (id,title,summary,body,source,tags,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  ins.run('wv-kw-1', TWO_HIT_TERM + '流程', '第一个夹具', 'body', '', '[]', 0.9, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')
  ins.run('wv-kw-2', TWO_HIT_TERM + '清单', '第二个夹具', 'body', '', '[]', 0.9, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')
  db.close()
  return dir
}
const FIX_DIR = makeTwoHitFixture()
after(() => rmSync(FIX_DIR, { recursive: true, force: true }))

test('semanticFallbackBelow 边界：命中 2 条时 below=3 发、below=2 不发（合起来证明命中数恰为 2）', async () => {
  await withMock(replyHits([]), async ({ endpoint, state }) => {
    const base = { dbDir: FIX_DIR, libs: [FIX_LIB], minScore: 3, semantic: true, semanticEndpoint: endpoint }

    const a = await mount({ ...base, semanticFallbackBelow: 3 })
    await run(a.handler, enter(realUser(TWO_HIT_TERM)))
    assert.equal(state.requests.length, 1, '2 < 3 → 走语义补充')

    const b = await mount({ ...base, semanticFallbackBelow: 2 })
    await run(b.handler, enter(realUser(TWO_HIT_TERM)))
    assert.equal(state.requests.length, 1, '2 < 2 为假 → 不再发（严格小于）')

    const c = await mount({ ...base, semanticFallbackBelow: 1 })
    await run(c.handler, enter(realUser(TWO_HIT_TERM)))
    assert.equal(state.requests.length, 1, '只有零命中才走时同样不发')
  })
})

test('关键词命中在先、语义补在后：合并不重排关键词、同 lib:id 去重', async () => {
  const DUP = { ...SEM_HIT, lib: FIX_LIB, id: 'wv-kw-1', title: '语义路径也召回了同一条' }
  const NEW = { ...SEM_HIT, id: 'wv-sem-2', title: '语义独有的第二条' }
  await withMock(replyHits([DUP, NEW]), async ({ endpoint }) => {
    const { handler } = await mount({
      dbDir: FIX_DIR, libs: [FIX_LIB], minScore: 3, maxHits: 4,
      semantic: true, semanticEndpoint: endpoint, semanticFallbackBelow: 3,
      maxTokensPerTurn: 400,
    })
    const result = await run(handler, enter(realUser(TWO_HIT_TERM)))
    const text = result.messages[1].content[0].text
    const order = ['wv-kw-1', 'wv-kw-2', 'wv-sem-2'].map((id) => text.indexOf(id))
    assert.ok(order.every((i) => i >= 0), '三条都该在注入文本里；实收=' + text)
    assert.deepEqual([...order].sort((x, y) => x - y), order, '关键词两条保持原序在前，语义独有那条补在后')
    assert.equal(text.split('wv-kw-1').length - 1, 1, '同 lib:id 只出现一次（去重，关键词优先）')
  })
})

test('语义路径修掉关键词死角：抽不出词（纯语气词）时仍走语义，命中照常注入', async () => {
  await withMock(replyHits([SEM_HIT]), async ({ endpoint, state }) => {
    const { handler } = await mount({
      dbDir: EMPTY_DIR, libs: ['work-skill'], minScore: 3,
      semantic: true, semanticEndpoint: endpoint,
    })
    assert.deepEqual(extractKeywords('好的'), [], '前提：这句确实抽不出词（同 prestep 用例的纯语气词）')
    const result = await run(handler, enter(realUser('好的')))
    assert.equal(state.requests.length, 1, '抽词为空也要走语义（这正是它要补的死角）')
    assert.equal(result.messages.length, 2)
    assert.match(result.messages[1].content[0].text, /wv-sem-1/)
  })
})

// ---- ⑤ 函数级契约 + 宿主纪律 ----

test('semanticSearch 返回值对齐 searchWeaver：rawScore=余弦×10、via=[semantic]、terms 留空', async () => {
  await withMock(replyHits([SEM_HIT, { ...SEM_HIT, id: 'wv-sem-2', score: 0.6 }]), async ({ endpoint }) => {
    const hits = await semanticSearch(QUERY, { endpoint, maxHits: 4, minScore: 0.42 })
    assert.equal(hits.length, 2)
    assert.equal(hits[0].lib, 'work-skill')
    assert.equal(hits[0].rawScore, 8, '0.8 × 10')
    assert.deepEqual(hits[0].via, ['semantic'])
    assert.deepEqual(hits[0].terms, [], '语义命中没有词面证据')
    assert.equal(hits[0].confidence, 0.9)
    assert.equal(hits[0].stale, false)
    assert.ok(Number.isFinite(hits[0].score))
    assert.equal(hits[1].rawScore, 6)
  })
})

test('semanticSearch：maxHits 截断、非法 score 过滤、缺 lib/id 过滤', async () => {
  const rows = [
    { ...SEM_HIT, id: 'a', score: 0.9 },
    { ...SEM_HIT, id: 'b', score: 0.8 },
    { ...SEM_HIT, id: 'c', score: 0.7 },
    { ...SEM_HIT, id: 'bad', score: 'NaN-ish' },
    { ...SEM_HIT, id: '', score: 0.95 },
  ]
  await withMock(replyHits(rows), async ({ endpoint }) => {
    const hits = await semanticSearch(QUERY, { endpoint, maxHits: 2 })
    assert.deepEqual(hits.map((h) => h.id), ['a', 'b'])
    const all = await semanticSearch(QUERY, { endpoint, maxHits: 10 })
    assert.deepEqual(all.map((h) => h.id), ['a', 'b', 'c'], '非数字 score 与空 id 被丢掉')
  })
})

test('宿主纪律：search.mjs 里没有宿主 ctx 访问（取向量只认 endpoint 字符串）', () => {
  const src = readFileSync(new URL('../src/search.mjs', import.meta.url), 'utf8')
  assert.equal(/\bctx\s*[.[]/.test(src), false, 'search.mjs 不得访问 ctx.* —— 端点靠参数传入（AGENTS.md）')
  assert.match(src, /export async function semanticSearch/)
  assert.match(src, /endpoint = 'http:\/\/127\.0\.0\.1:8765'/)
})

test('默认关的判据（静态）：Config.semantic 默认 false，且三条短路都在', () => {
  const src = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  assert.match(src, /semantic: z\.boolean\(\)\.default\(false\)/, 'Config 默认必须是 false（A/B/W 无 8765）')
  assert.match(src, /semantic: false,/, 'apply 的 cfg 兜底也要 false')
  assert.match(src, /if \(terms\.length === 0 && cfg\.semantic === false\) return decision/)
  assert.match(src, /if \(cfg\.semantic !== false && hits\.length < /)
})

test('ALL_LIBS 未因语义路径改动（8 库）', () => {
  assert.equal(ALL_LIBS.length, 8)
})
