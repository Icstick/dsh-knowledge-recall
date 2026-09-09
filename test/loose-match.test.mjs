// test/loose-match.test.mjs — 2026-09-09：CJK bigram 松散匹配（trigram 思路的过渡版）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { searchWeaver, cjkBigrams } from '../src/search.mjs'

test('cjkBigrams：重叠 2-gram、去重、非 CJK 段跳过', () => {
  assert.deepEqual(cjkBigrams('干员基建'), ['干员', '员基', '基建'])
  assert.deepEqual(cjkBigrams('abc'), [])
  assert.deepEqual(cjkBigrams('a干员b'), ['a干', '干员', '员b'].filter((g) => /[\u4e00-\u9fff]/.test(g)))
  assert.deepEqual(cjkBigrams(''), [])
})

test('松散匹配：词序不同也能命中（整词 LIKE 失手时兜底），但分数打折', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-loose-'))
  try {
    const { db } = makeDb(dir, 'work-skill')
    const ins = db.prepare('INSERT INTO entries (id,title,summary,body,source,tags,confidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    const now = new Date().toISOString()
    ins.run('exact', '干员基建', '排班', '', '', '[]', 0.9, now, now)
    ins.run('loose', '基建干员', '排班', '', '', '[]', 0.9, now, now)
    ins.run('none', '无关主题', '别的', '', '', '[]', 0.9, now, now)
    db.close()
    const hits = await searchWeaver(['干员基建'], { dbDir: dir, libs: ['work-skill'], minScore: 1 })
    const byId = Object.fromEntries(hits.map((h) => [h.id, h]))
    assert.ok(byId.exact, '整词命中必须在')
    assert.ok(byId.loose, '词序不同也要能命中（松散兜底）')
    assert.ok(!byId.none)
    assert.ok(byId.exact.rawScore > byId.loose.rawScore, '整词命中分数应高于松散命中')
    assert.ok([...byId.loose.via].includes('like-loose'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function makeDb(dir, lib) {
  const file = join(dir, lib + '.db')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, title TEXT, summary TEXT, body TEXT, source TEXT, tags TEXT, confidence REAL, created_at TEXT, updated_at TEXT)')
  return { db, file }
}
