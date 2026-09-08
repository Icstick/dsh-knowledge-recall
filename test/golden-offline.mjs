// 离线黄金用例：真实 weaver-kb 上跑 提取词→检索→格式化（不挂 dsh，仅验证召回）
import { extractKeywords, formatHits } from '../src/recall.mjs'
import { searchWeaver } from '../src/search.mjs'
import { DEFAULT_ALIASES } from '../src/aliases.mjs'

const CASES = [
  { name: 'G1 方舟基建提问', text: '姐你知道明日方舟基建系统怎么配效率最高吗', expectLibs: ['lore', 'project'] },
  { name: 'G2 会话格式技术提问', text: '帮我看看 dsh 的 session zstd 文件怎么读取解析', expectLibs: ['work-skill', 'software-config'] },
  { name: 'G3 闲聊', text: '今天天气不错，中午吃什么好呢', expect: 'none' },
  { name: 'G4 代号', text: '按 P7 开工包流程开始吧', expectLibs: [] },
  { name: 'G5 插件开发', text: '给插件加设置页卡片，settingsScope 报错没有 inject', expectLibs: ['software-config', 'work-skill'] },
]
const aliases = { ...DEFAULT_ALIASES, P7: 'P7 开工包 流程' }
for (const c of CASES) {
  const terms = extractKeywords(c.text, { aliases })
  const hits = await searchWeaver(terms, { minScore: 4, maxHits: 4 })
  const out = formatHits(hits, { maxTokens: 400 })
  console.log('==== ' + c.name)
  console.log('  terms: ' + JSON.stringify(terms))
  console.log('  hits: ' + hits.map(h => h.lib + '/' + h.id + ':' + h.score).join(' ') || '(无)')
  if (out.text) console.log('  inject(' + out.text.length + 'ch): ' + out.text.slice(0, 200).replace(/\n/g, ' | '))
  else console.log('  inject: (空)')
}