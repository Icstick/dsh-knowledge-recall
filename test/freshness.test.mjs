// test/freshness.test.mjs — 2026-09-09：confidence / updated_at 参与打分与注入标注
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { searchWeaver, parseTimestamp, STALE_DAYS } from '../src/search.mjs'
import { formatHits } from '../src/recall.mjs'

function makeDb(dir, lib, withMeta = true) {
  const file = join(dir, lib + '.db')
  const db = new DatabaseSync(file)
  if (withMeta) {
    db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT, summary TEXT, body TEXT, source TEXT, tags TEXT, confidence REAL, created_at TEXT, updated_at TEXT)')
  } else {
    db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT, summary TEXT, body TEXT, source TEXT, tags TEXT)')
  }
  return { db, file }
}

test('parseTimestamp：ISO 带 Z / 不带 Z / epoch 秒 / epoch 毫秒 / 非法', () => {
  assert.equal(parseTimestamp('2026-09-08T00:00:00Z'), Date.parse('2026-09-08T00:00:00Z'))
  assert.equal(parseTimestamp('2026-09-08T00:00:00'), Date.parse('2026-09-08T00:00:00Z'), '无时区按 UTC')
  assert.equal(parseTimestamp(1784013556), 1784013556000, 'epoch 秒')
  assert.equal(parseTimestamp(1784013556000), 1784013556000, 'epoch 毫秒')
  assert.equal(parseTimestamp('not-a-date'), null)
  assert.equal(parseTimestamp(''), null)
  assert.equal(parseTimestamp(null), null)
})

test('低置信条目排序靠后，但召回量不缩水（rawScore 守门槛）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-fresh-'))
  try {
    const { db } = makeDb(dir, 'project')
    const ins = db.prepare('INSERT INTO entries (id,title,summary,body,source,tags,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    const today = new Date().toISOString()
    ins.run('hi', '部署流程手册', '部署 细节', '', '', '[]', 0.95, today, today)
    ins.run('lo', '部署流程草稿', '部署 草稿', '', '', '[]', 0.10, today, today)
    db.close()
    const hits = await searchWeaver(['部署'], { dbDir: dir, libs: ['project'], minScore: 4 })
    assert.equal(hits.length, 2, '两者都过 rawScore 门槛，召回量不变')
    assert.equal(hits[0].id, 'hi', '高置信排前')
    assert.ok(hits[0].score > hits[1].score)
    assert.equal(hits[0].confidence, 0.95)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('陈旧条目带 stale 标记并降权', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-fresh2-'))
  try {
    const { db } = makeDb(dir, 'lore')
    const ins = db.prepare('INSERT INTO entries (id,title,summary,body,source,tags,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    const today = new Date()
    const old = new Date(today.getTime() - (STALE_DAYS + 30) * 86400000)
    ins.run('new', '服务器加固基线', '加固 基线', '', '', '[]', 0.9, today.toISOString(), today.toISOString())
    ins.run('old', '服务器加固旧稿', '加固 旧稿', '', '', '[]', 0.9, old.toISOString(), old.toISOString())
    db.close()
    const hits = await searchWeaver(['加固'], { dbDir: dir, libs: ['lore'], minScore: 4 })
    const byId = Object.fromEntries(hits.map((h) => [h.id, h]))
    assert.equal(byId.new.stale, false)
    assert.equal(byId.old.stale, true)
    assert.ok(byId.old.score < byId.new.score, '陈旧条目应降权')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('缺 confidence/updated_at 列的旧库：降级不报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-fresh3-'))
  try {
    const { db } = makeDb(dir, 'web', false)
    db.prepare('INSERT INTO entries (id,title,summary,body,source,tags) VALUES (?,?,?,?,?,?)')
      .run('w1', '代理配置备忘', '代理 细节', '', '', '[]')
    db.close()
    const hits = await searchWeaver(['代理'], { dbDir: dir, libs: ['web'], minScore: 3 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].confidence, null)
    assert.equal(hits[0].updatedAt, null)
    assert.equal(hits[0].stale, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('formatHits：注入行附 conf 与更新时间，陈旧标「未复核」', () => {
  const now = Date.now()
  const r = formatHits([
    { lib: 'project', id: 'wv-1', title: '标题', summary: '摘要', confidence: 0.8, updatedAt: now, stale: false },
    { lib: 'lore', id: 'wv-2', title: '旧标题', summary: '旧摘要', confidence: null, updatedAt: now - 999 * 86400000, stale: true },
  ], { maxTokens: 400, maxHits: 4 })
  assert.ok(r.text.includes('conf=0.8'), r.text)
  assert.ok(r.text.includes('更新于 ' + new Date(now).toISOString().slice(0, 10)), r.text)
  assert.ok(r.text.includes('未复核·更新于'), r.text)
})
