/**
 * 内置专名/代号 → 查询词表（零依赖）。
 * 值支持空格分词（多个查询词）。可在 settings.yaml 用 aliases 追加覆盖。
 * @module dsh-knowledge-recall/aliases
 */
export const DEFAULT_ALIASES = {
  'ak-tools': '明日方舟 干员 练度',
  'ak工具': '明日方舟 干员 练度',
  '明日方舟': '明日方舟',
  '终末地': '明日方舟 终末地',
  '基建': '明日方舟 基建',
  'desktop-shell': 'dsh-desktop-shell',
  '桌面壳': 'dsh-desktop-shell',
  'ACP': 'dsh-adaptive-context',
  'adaptive-context': 'dsh-adaptive-context',
  'context-maid': 'dsh-context-maid',
  'maid': 'dsh-context-maid',
  'work-continuity': 'dsh-work-continuity',
  'checkpoint': 'dsh-work-continuity',
  'weaver': 'weaver 知识库',
  'memo': 'dsh-memento 记忆',
  'workbox': 'workbox 任务分发',
  'frp': 'frp 隧道',
  'zstd': 'zstd 会话 压缩',
  '会话损坏': '会话 修复 zstd',
  'wsl': 'WSL 服务器',
  'headless': 'headless DSH 云端',
  'lore': 'weaver lore 游戏设定',
  'P7': 'P7 开工包 流程',
  'LLM娘': 'LLM 角色',
}
