# 主实例挂载验证清单（2026-09-08，重启后执行）

挂载动作已完成：
- `C:\Users\Administrator\.dsh\profiles\web\package.json`：dependencies 加 `dsh-knowledge-recall: link:...`；bundles 数组加 `dsh-knowledge-recall`
- profiles/web pnpm install 通过；node_modules 符号链接就位
- repo 本地 peer 已装（pnpm install），import 验证 OK，单测 15/15

## 重启后验证步骤
1. 观察 GUI 首条消息（提一个知识型问题如「weaver 里有什么 zstd 会话读取的知识吗」或「明日方舟基建相关」）——期望回合首步出现折叠的上下文注入 `[knowledge-recall] weaver ...`
2. 若无注入：查 `C:\Users\Administrator\.dsh\logs` 下日志含 `knowledge-recall` 的 warn（fail-open 只降级不阻断）
3. 闲聊消息（无知识词）应无注入
4. 检查 settings 页/插件列表出现 knowledge-recall（enabled 默认 true）

## 临时开关
若需快速关：settings.yaml 加
```yaml
knowledge-recall:
  enabled: false
```
（或调 minScore / maxTokensPerTurn / aliases）

## 备注
- 裸 `node import('dsh-knowledge-recall')` 从 profile 外会报 peer 缺失——属正常（宿主用自身 resolver，同 time-ink）
- 本会话即主实例：重启会断开本会话；验证在重启后的新会话按本清单执行
