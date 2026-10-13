import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MIN_N, N_CAP, STRENGTH_WEIGHT,
  bump, load, prune, save, strengthOf, strengthPath,
} from '../src/strength.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'strength-'))
const NOW = Date.parse('2026-10-02T00:00:00Z')
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const empty = () => ({ version: 1, entries: {} })

test('strengthOf：没有记录是 0；n < MIN_N 不计；到 MIN_N 才起算', () => {
  const d = empty()
  assert.equal(strengthOf(d, 'web', 'x', NOW), 0)
  bump(d, 'web', 'x', NOW)
  assert.equal(strengthOf(d, 'web', 'x', NOW), 0, '一次是偶然，门槛是 ' + MIN_N)
  bump(d, 'web', 'x', NOW + 13 * HOUR)
  const s = strengthOf(d, 'web', 'x', NOW + 13 * HOUR)
  assert.ok(Math.abs(s - Math.log(3) / Math.log(1 + N_CAP)) < 1e-9, 'n=2 时应为 ln(3)/ln(9)，实际 ' + s)
})

test('strengthOf：半衰期 90 天——刚记满的条目放 90 天，强度掉一半', () => {
  const d = empty()
  d.entries['web/x'] = { n: 8, first: new Date(NOW - 90 * DAY).toISOString(), last: new Date(NOW - 90 * DAY).toISOString() }
  const s = strengthOf(d, 'web', 'x', NOW)
  assert.ok(Math.abs(s - 0.5) < 1e-9, '实际 ' + s)
  assert.ok(STRENGTH_WEIGHT > 0 && STRENGTH_WEIGHT <= 0.35, '权重应落在弱加权区间')
})

test('bump：首次建条目；半天内重复引用不再计数；过了半天才记', () => {
  const d = empty()
  assert.equal(bump(d, 'web', 'x', NOW), true)
  assert.equal(d.entries['web/x'].n, 1)
  assert.equal(bump(d, 'web', 'x', NOW + 1 * HOUR), false, '半天内应被间隔守卫挡掉')
  assert.equal(d.entries['web/x'].n, 1)
  assert.equal(bump(d, 'web', 'x', NOW + 13 * HOUR), true)
  assert.equal(d.entries['web/x'].n, 2)
  assert.equal(d.entries['web/x'].first, new Date(NOW).toISOString(), 'first 不该被刷新')
})

test('prune：超过 keep 条时只留最近用过的', () => {
  const d = empty()
  for (let i = 0; i < 5; i++) d.entries['web/e' + i] = { n: 1, last: new Date(NOW - i * DAY).toISOString() }
  prune(d, 2)
  assert.deepEqual(Object.keys(d.entries).sort(), ['web/e0', 'web/e1'])
})

test('load/save：坏 JSON 当空表，写坏了不抛；roundtrip 一致', () => {
  const dir = tmp()
  const f = path.join(dir, 'memory-strength.json')
  assert.deepEqual(load(f), empty(), '缺文件 → 空表')
  fs.writeFileSync(f, '{oops')
  assert.deepEqual(load(f), empty(), '坏 JSON → 空表')
  const d = empty()
  bump(d, 'project', 'wv-1', NOW)
  assert.equal(save(f, d), true)
  assert.deepEqual(load(f), d)
  assert.equal(save(path.join(dir, '不存在的目录', 'x.json'), d), false, '写不进返回 false 而不是抛')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('strengthPath：认 DSH_HOME，落点与 weaver 库分开', () => {
  const p = strengthPath({ DSH_HOME: path.join('D:', 'fake-home') })
  assert.equal(p, path.join('D:', 'fake-home', 'memory-strength.json'))
  assert.ok(!/weaver-kb/.test(p))
})
