import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { searchWeaver, defaultDbDir, ALL_LIBS, bumpAccessCounts } from '../src/search.mjs'

function makeDb(dir, lib) {
  const file = join(dir, lib + '.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT, summary TEXT, body TEXT, source TEXT, tags TEXT, confidence REAL, created_at TEXT, updated_at TEXT)')
  return { db, file }
}

function insert(db, row) {
  db.prepare('INSERT INTO entries (id,title,summary,body,source,tags,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(row.id, row.title, row.summary, row.body, row.source || '', row.tags || '', row.confidence ?? 0.9, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z')
}

test('searchWeaver：CJK 词 title 命中并按分排序', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-test-'))
  try {
    const { db, file } = makeDb(dir, 'work-skill')
    insert(db, { id: 'wv-a1', title: '明日方舟基建系统设计', summary: '贸易站与制造站效率', body: '细节', tags: '["明日方舟","基建"]' })
    insert(db, { id: 'wv-a2', title: '无关主题', summary: '别的', body: '别的', tags: '[]' })
    insert(db, { id: 'wv-a3', title: '基建排班技巧', summary: '排班轮换', body: 'x', tags: '[]' })
    db.close()

    const hits = await searchWeaver(['基建'], { dbDir: dir, libs: ['work-skill'], minScore: 4, maxHits: 4 })
    assert.ok(hits.length >= 1)
    // a1: title(3)+tags(2)+summary(2)=7；a3: title(3)=3 → minScore 4 排除
    assert.equal(hits[0].id, 'wv-a1')
    assert.ok(hits.every(h => h.id !== 'wv-a2'))
    assert.ok(hits.every(h => h.id !== 'wv-a3'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchWeaver：多词聚合加分', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-test-'))
  try {
    const { db, file } = makeDb(dir, 'project')
    insert(db, { id: 'p1', title: 'AK 工具需求', summary: '明日方舟干员练度', body: 'MAA 导入', tags: '[]' })
    insert(db, { id: 'p2', title: '其他项目', summary: '无', body: '无', tags: '[]' })
    db.close()
    const hits = await searchWeaver(['明日方舟', '干员'], { dbDir: dir, libs: ['project'], minScore: 4, maxHits: 2 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 'p1')
    assert.ok(hits[0].terms.length >= 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchWeaver：缺库/空词 fail-open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-test-'))
  try {
    const hits = await searchWeaver(['随便'], { dbDir: dir, libs: ['work-skill', 'lore'], minScore: 4 })
    assert.deepEqual(hits, [])
    assert.deepEqual(await searchWeaver([], {}), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ALL_LIBS 覆盖 8 库且 defaultDbDir 合理', () => {
  assert.equal(ALL_LIBS.length, 8)
  const d = defaultDbDir()
  assert.ok(d.includes('weaver-kb') && d.includes('db'))
})
test('searchWeaver：命中后累加 access_count / last_access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-test-'))
  try {
    const { db, file } = makeDb(dir, 'work-skill')
    db.exec('ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0')
    db.exec('ALTER TABLE entries ADD COLUMN last_access TEXT')
    insert(db, { id: 'wv-cnt', title: '备份清理流程', summary: '快照与清理', body: 'x', tags: '[]' })
    db.close()

    const read = () => {
      const r = new DatabaseSync(file, { readOnly: true })
      try { return r.prepare('SELECT access_count, last_access FROM entries WHERE id = ?').get('wv-cnt') } finally { r.close() }
    }
    assert.equal(read().access_count, 0)

    // 注意查询词要与 title/summary 都真命中：'清理' 在 title(3)+summary(2)=5 ≥ minScore 4
    // 2026-09-10：默认不回写（bumpHotness 默认 false）；本用例显式开启以覆盖回写路径。
    const hits = await searchWeaver(['清理'], { dbDir: dir, libs: ['work-skill'], minScore: 4, maxHits: 4, bumpHotness: true })
    assert.ok(hits.length >= 1, 'expected at least one hit for 清理')
    const afterSearch = read()
    assert.equal(afterSearch.access_count, 1, 'bumpHotness:true 时 search 累加一次')
    assert.ok(afterSearch.last_access, 'last_access 应写入')

    bumpAccessCounts(hits, dir)
    assert.equal(read().access_count, 2, '显式 bump 再累加一次')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('searchWeaver：默认不回写 access_count（recallHotness 默认关，2026-09-10 审计）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-test-'))
  try {
    const { db, file } = makeDb(dir, 'work-skill')
    db.exec('ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0')
    db.exec('ALTER TABLE entries ADD COLUMN last_access TEXT')
    insert(db, { id: 'wv-noheat', title: '备份清理流程', summary: '快照与清理', body: 'x', tags: '[]' })
    db.close()

    const read = () => {
      const r = new DatabaseSync(file, { readOnly: true })
      try { return r.prepare('SELECT access_count, last_access FROM entries WHERE id = ?').get('wv-noheat') } finally { r.close() }
    }

    const hits = await searchWeaver(['清理'], { dbDir: dir, libs: ['work-skill'], minScore: 4, maxHits: 4 })
    assert.ok(hits.length >= 1, 'expected at least one hit for 清理')
    const after = read()
    assert.equal(after.access_count, 0, '默认不得回写生产库（调研结论：不回写 weaver 库）')
    assert.equal(after.last_access, null, '默认不得写 last_access')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bumpAccessCounts：库缺失/命中为空时 fail-open 不抛错', () => {
  assert.equal(bumpAccessCounts([], 'C:/definitely/not/here'), 0)
  assert.equal(bumpAccessCounts([{ lib: 'work-skill', id: 'x' }], 'C:/definitely/not/here'), 0)
  assert.equal(bumpAccessCounts(null, 'C:/definitely/not/here'), 0)
})