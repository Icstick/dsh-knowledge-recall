import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRealUserMessage,
  hasRealUserMessage,
  lastRealUserText,
  messageText,
  extractKeywords,
  stripBoilerplate,
  formatHits,
  hitSignature,
  RecallThrottle,
  injectedPluginChars,
} from '../src/recall.mjs'

test('isRealUserMessage 只认 source.kind=user', () => {
  const real = { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const plugin = { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'x' } }
  assert.equal(isRealUserMessage(real), true)
  assert.equal(isRealUserMessage(plugin), false)
  assert.equal(isRealUserMessage(null), false)
  assert.equal(isRealUserMessage({ role: 'user' }), false)
})

test('lastRealUserText 取最后一条真实用户文本', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '[acp] x' }], source: { kind: 'plugin', plugin: 'acp' } },
    { role: 'user', content: [{ type: 'text', text: '姐姐早' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: '帮我看看 zstd' }], source: { kind: 'user' } },
  ]
  assert.equal(hasRealUserMessage(msgs), true)
  assert.equal(lastRealUserText(msgs), '帮我看看 zstd')
  assert.equal(lastRealUserText([]), '')
  assert.equal(messageText(null), '')
})

test('extractKeywords：CJK 4-12 字整段', () => {
  const ks = extractKeywords('明日方舟基建系统怎么配', {})
  assert.ok(ks.some(k => k.includes('明日方舟基建系统')), JSON.stringify(ks))
})

test('extractKeywords：长中文滑窗不溢出 maxTerms', () => {
  const ks = extractKeywords('我需要把云服务器上的uptime kuma和alist还有aria2都配置监控和云盘还要处理frp隧道问题', {})
  assert.ok(ks.length <= 6)
  assert.ok(ks.some(k => k.includes('服务器')), JSON.stringify(ks))
})

test('extractKeywords：拉丁词过滤停用词', () => {
  const ks = extractKeywords('can you check the zstd session format please', {})
  assert.ok(ks.includes('zstd'))
  assert.ok(!ks.includes('the'))
  assert.ok(!ks.includes('can'))
})

test('extractKeywords：别名命中（CJK 与拉丁 key）', () => {
  const aliases = { '明日方舟': '干员 基建', 'zstd': '会话 压缩', ACP: 'dsh-adaptive-context' }
  const ks1 = extractKeywords('明日方舟基建效率讨论', { aliases })
  assert.ok(ks1.some(k => k === '干员' || k === '基建'), JSON.stringify(ks1))
  const ks2 = extractKeywords('帮忙看下 ACP 的跨会话注入', { aliases })
  assert.ok(ks2.includes('dsh-adaptive-context'), JSON.stringify(ks2))
})

test('extractKeywords：CJK 引导词剥离', () => {
  const ks1 = extractKeywords('帮我看看明日方舟基建效率怎么配', {})
  assert.ok(ks1.some(k => k.includes('明日方舟基建')), JSON.stringify(ks1))
  // 纯引导短语段应被丢弃（剥后不足 4 字）
  const ks2 = extractKeywords('麻烦帮我看看', {})
  assert.ok(ks2.length === 0, JSON.stringify(ks2))
})

test('stripBoilerplate 剔除 acp/reminder 样板', () => {
  const raw = '确认待办\n[acp:user_input | id=x] 历史回显\n[work-state] goal: xxx\n请继续'
  const clean = stripBoilerplate(raw)
  assert.ok(!clean.includes('acp:user_input'))
  assert.ok(!clean.includes('work-state'))
  assert.ok(clean.includes('确认待办'))
})

test('formatHits：预算截断与空命中', () => {
  const hits = [
    { lib: 'work-skill', id: 'wv-1', title: '标题一', summary: '摘要 '.repeat(30), score: 9 },
    { lib: 'lore', id: 'wv-2', title: '标题二', summary: '短摘要', score: 5 },
  ]
  const { text, hits: used } = formatHits(hits, { maxTokens: 400, maxHits: 4 })
  assert.ok(text.startsWith('[knowledge-recall] weaver work-skill/wv-1《'))
  assert.ok(used.length >= 1)
  assert.equal(formatHits([], {}).text, '')
  // 极紧预算
  const tight = formatHits(hits, { maxTokens: 1 })
  assert.equal(tight.text, '')
})

test('RecallThrottle：同签名跳过，异签名放行', () => {
  const th = new RecallThrottle()
  assert.equal(th.propose('s1', 'a,b'), 'a,b')
  assert.equal(th.propose('s1', 'a,b'), null)
  assert.equal(th.propose('s1', 'a,c'), 'a,c')
  assert.equal(th.propose('s2', 'a,c'), 'a,c')
  assert.equal(th.propose('s1', ''), null)
})

test('hitSignature', () => {
  assert.equal(hitSignature([{ lib: 'a', id: '1' }, { lib: 'b', id: '2' }]), 'a/1,b/2')
  assert.equal(hitSignature([], 3), '')
})

test('injectedPluginChars 统计插件注入文本', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'aaa' }], source: { kind: 'plugin:dsh-adaptive-context' } },
    { role: 'user', content: [{ type: 'text', text: '真实' }], source: { kind: 'user' } },
  ]
  assert.equal(injectedPluginChars(msgs), 3)
})
