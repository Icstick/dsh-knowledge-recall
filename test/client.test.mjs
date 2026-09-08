import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = readFileSync(join(root, 'client', 'index.js'), 'utf8')
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

test('client 源：注册与注入声明完整', () => {
  assert.ok(src.includes("const NS = 'knowledge-recall'"))
  assert.ok(src.includes("ctx.slots.inject('settings.section'"))
  assert.ok(src.includes("id: 'knowledge-recall'"))
  assert.ok(src.includes("exports.inject = ['slots', 'settingsScope']"))
  assert.ok(src.includes('maxTokensPerTurn') && src.includes('minScore') && src.includes('openingScan'))
})

test('client bundle：已构建且含关键片段', () => {
  assert.ok(bundle.includes('window.__ModuleLoader__.load({'))
  assert.ok(bundle.includes('dsh-knowledge-recall'))
  assert.ok(bundle.includes('exports.apply = apply;'))
  assert.ok(bundle.includes('知识召回'))
})
