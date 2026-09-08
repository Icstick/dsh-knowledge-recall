import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { searchWeaver, defaultDbDir, ALL_LIBS } from '../src/search.mjs'

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
