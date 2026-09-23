// client/index.js — dsh-knowledge-recall 设置页（bundle-ready CJS 风格源码）。
//
// 构建：node scripts/build-client.mjs → lib/client.js。
// dsh.client.inject 声明包关系；Cordis 服务依赖由下方 exports.inject 声明并控制激活。
// react 由平台预加载，ui-slots 提供 ctx.slots，ui-settings 提供 ctx.settingsScope。
// 自包含：字段渲染 + staged 草稿 + 保存自实现（参照 dsh-work-continuity client）。
// 注册为设置面板顶层 section（settings.section「知识召回」）。
// 文案写死中文（v1 不做 i18n）。

// React 无顶层 h（那是 preact 的 API）——createElement 起别名 h 供组件使用
const { createElement: h, useState, useSyncExternalStore } = require('react')

/** 设置页 namespace（与 host 侧 SETTINGS_NAMESPACE 一致） */
const NS = 'knowledge-recall'

const TITLE = '知识召回（Knowledge Recall）'
const DESC = 'weaver 自动知识注入 · 命中才注入 · 主/子代理通吃'

const FIELDS = [
  { name: 'enabled', label: '启用自动召回', type: 'toggle', hint: '总开关；关闭后不注入任何知识条目' },
  { name: 'maxTokensPerTurn', label: '单轮注入预算（tokens）', type: 'number', hint: '0 = 关闭注入；默认 400；子代理自动 ×0.5' },
  { name: 'minScore', label: '命中最低分', type: 'number', hint: 'title 命中≈3；默认 4；太低会混入弱相关条目' },
  { name: 'maxHits', label: '单轮最多注入条数', type: 'number', hint: '默认 4' },
  { name: 'openingScan', label: '开场宽检索', type: 'toggle', hint: '会话首回合放宽词数/阈值（默认开）' },
  { name: 'subagentBudgetFactor', label: '子代理预算系数', type: 'number', hint: 'delegationDepth>0 时预算 ×系数（默认 0.5）' },
  { name: 'dbDir', label: '知识库目录（可选）', type: 'text', hint: '留空 = $DSH_HOME/weaver-kb/db；aliases/libs 等复杂项请编辑 settings.yaml' },
]

function draftOf(value) {
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (value === null || value === undefined) return ''
  return String(value)
}

function parseDraft(field, text) {
  const trimmed = String(text ?? '').trim()
  if (field.type === 'toggle') return trimmed === 'true'
  if (trimmed === '') return null
  if (field.type === 'number') {
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return undefined
    return n
  }
  return trimmed
}

const rowStyle = {
  display: 'flex', flexDirection: 'column', gap: '4px',
  padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
}
const labelStyle = { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #1f2937)' }
const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' }
const inputStyle = {
  fontSize: '13px', padding: '4px 8px', borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
  background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary, #111827)',
}
const badgeStyle = {
  fontSize: '11px', color: '#b45309', background: '#fef3c7',
  borderRadius: '999px', padding: '1px 8px', marginLeft: '8px',
}
const resetBtnStyle = {
  fontSize: '12px', color: '#b45309', background: 'none', border: 'none',
}

function FieldControl({ field, value, draft, overridden, disabled, onDraft, onReset }) {
  const text = draft !== undefined ? draft : draftOf(value)
  const common = {
    id: 'kr-field-' + field.name,
    disabled,
    style: inputStyle,
    value: field.type === 'toggle' ? (text === 'true') : text,
  }
  let control
  if (field.type === 'toggle') {
    control = h('input', {
      ...common, type: 'checkbox', checked: text === 'true',
      onChange: (e) => onDraft(String(e.target.checked)),
    })
  } else {
    control = h('input', {
      ...common, type: 'text',
      onChange: (e) => onDraft(e.target.value),
    })
  }
  return h('div', { style: rowStyle },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
      h('label', { htmlFor: common.id, style: labelStyle }, field.label),
      overridden ? h('span', { style: badgeStyle }, '已覆盖') : null),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, control,
      overridden ? h('button', { type: 'button', style: resetBtnStyle, disabled, onClick: onReset }, '重置') : null),
    field.hint ? h('div', { style: hintStyle }, field.hint) : null)
}

/** 设置 section 面板组件（自包含：闭包捕获 bound scope）。 */
function makeSection(scope) {
  return function Section() {
    const snapshot = useSyncExternalStore(
      (cb) => scope.subscribe(cb),
      () => scope.getSnapshot(),
    )
    const value = snapshot?.value && typeof snapshot.value === 'object' ? snapshot.value : {}
    const userLayer = snapshot?.user && typeof snapshot.user === 'object' ? snapshot.user : {}
    const writable = snapshot?.writable === true
    const [drafts, setDrafts] = useState(null)
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)

    const dirty = drafts !== null
    const invalid = dirty && FIELDS.some((f) =>
      drafts[f.name] !== undefined && parseDraft(f, drafts[f.name]) === undefined)

    async function save() {
      if (!dirty || invalid || saving) return
      setSaving(true); setFailed(false)
      try {
        const writes = []
        for (const field of FIELDS) {
          if (!(field.name in drafts)) continue
          const parsed = parseDraft(field, drafts[field.name])
          if (parsed === undefined) continue
          if (parsed === null) writes.push(scope.unset(field.name))
          else writes.push(scope.set(field.name, parsed))
        }
        await Promise.all(writes)
        setDrafts(null)
      } catch {
        setFailed(true)
      } finally {
        setSaving(false)
      }
    }

    function discard() { setDrafts(null); setFailed(false) }
    function onDraft(name, text) {
      setFailed(false)
      setDrafts((prev) => { const next = { ...prev }; next[name] = text; return next })
    }
    function onReset(name) {
      setFailed(false)
      setDrafts((prev) => { const next = { ...prev }; next[name] = ''; return next })
    }

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '2px 2px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)' } },
        h('span', { style: { fontWeight: 600, fontSize: '15px', color: 'var(--dsw-alias-label-primary, #111827)' } }, TITLE),
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, DESC),
        dirty ? h('span', { style: badgeStyle }, '未保存') : null),
      h('div', { style: { padding: '2px 2px 8px' } },
        !writable ? h('p', { role: 'status', style: hintStyle }, '当前文档不可写（只读模式）') : null,
        FIELDS.map((field) => h(FieldControl, {
          key: field.name, field,
          value: value[field.name],
          draft: drafts ? drafts[field.name] : undefined,
          overridden: userLayer[field.name] !== undefined,
          disabled: !writable || saving,
          onDraft: (text) => onDraft(field.name, text),
          onReset: () => onReset(field.name),
        })),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', paddingTop: '12px' } },
          failed ? h('p', { role: 'status', style: { ...hintStyle, color: '#b91c1c', marginRight: 'auto', alignSelf: 'center' } }, '保存失败，请重试') : null,
          h('button', {
            type: 'button', disabled: !dirty || saving,
            style: { ...inputStyle, background: 'none', color: '#6b7280', cursor: 'pointer' },
            onClick: discard,
          }, '放弃'),
          h('button', {
            type: 'button', disabled: !dirty || invalid || saving,
            style: {
              ...inputStyle, cursor: 'pointer', fontWeight: 600,
              background: 'var(--dsw-alias-accent, #2563eb)', color: '#fff', borderColor: 'transparent',
            },
            onClick: save,
          }, saving ? '保存中…' : '保存')))
    )
  }
}

/**
 * client 插件入口：注册为设置面板顶层 section。
 *
 * 双版本兼容（2026-09-23）：
 *   dsh ≤0.1.6 —— ui-settings 提供 ctx.settingsScope，卡片照旧渲染、读写 settings.yaml；
 *   dsh ≥0.1.7 —— settingsScope 已删除（0.1.7 由平台按 host 侧 Config 的 volatile 字段生成表单）。
 *     静态 `exports.inject` 里列 'settingsScope' 会让本条目在 0.1.7 上一直 pending
 *     （顶栏 "Failed to load plugins … waiting for service: settingsScope"），
 *     所以改成命令式 ctx.inject(['settingsScope'], …)：服务不存在时回调不触发，
 *     条目照常激活，0.1.7 上不注册自绘卡片。全程 fail-open，绝不抛出。
 */
function apply(ctx) {
  try {
    ctx.inject(['settingsScope'], (scopeCtx) => {
      try {
        const scope = scopeCtx.settingsScope.bind({ namespace: NS })
        if (!scope || typeof scope.getSnapshot !== 'function') return
        scopeCtx.slots.inject('settings.section', () => scopeCtx.slots.register(
          { name: 'settings.section', id: 'knowledge-recall', order: 160, label: '知识召回' },
          makeSection(scope),
        ))
      } catch { /* fail-open：卡片注册失败不影响条目激活 */ }
    })
  } catch { /* fail-open：注入声明本身失败也不外抛 */ }
}

// 'settingsScope' 不在静态 inject 里 —— 它在 0.1.7 不存在，列上会 gate 掉整个条目。
exports.inject = ['slots']
// build.mjs 模板注入 exports.apply
exports.apply = apply
