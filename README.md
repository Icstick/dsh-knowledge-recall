# dsh-knowledge-recall

weaver 知识自动召回：真实用户消息到达时，自动检索本地 weaver 知识库（8 库 SQLite 直读）并把高置信相关条目摘要注入上下文——命中才注入、预算可控、主/子代理通吃。

## 背景与问题

沉淀进 weaver 的知识（游戏 lore / 项目沿革 / 踩坑经验等 800+ 条目）获取全靠模型自觉：整句 CJK 查询召回差、子代理从不被告知可用。本插件把「知识取用」自动化：回合首步先查库，有相关就带一句摘要（含条目 id，可深挖 weaver_read）。

设计文档：`docs/design.md`（v1，2026-09-08 定稿；全案见 DSH 工作区 `docs/plans/knowledge-flow-plan-20260908.md`）。

## 机制

```
[真实 user 消息] → 关键词化（别名表 + 拉丁词 + CJK 滑窗）
  → 8 库 SQLite 检索（LIKE 加权；纯拉丁补 FTS5 前缀）
  → 命中过滤（minScore / 预算 / 节流）
  → pre-step 注入 ≤ maxTokensPerTurn（子代理 ×subagentBudgetFactor）
```

- 挂 `agent/pre-step` waterfall（step===1 且含真实用户消息），与 ACP / time-ink 注入同族（source-labelled，可审计、折叠呈现）
- 合计护栏：与 ACP/memento 等插件注入合计 ≤ 900 tokens/step（按决策消息中 plugin 注入字符估算）
- 节流：同会话同命中集合不重复注入
- fail-open：检索/注入故障仅降级日志，不阻断回合

## 配置（settings.yaml namespace knowledge-recall）

```yaml
knowledge-recall:
  enabled: true
  maxTokensPerTurn: 400    # 0 = 关
  minScore: 4              # title 命中≈3；多字段/多词加分（M2 实测标定）
  libs: [lore, project, hardware, software-code, software-config, web, work-skill, workflow]
  maxHits: 4
  subagentBudgetFactor: 0.5
  dbDir: ''                # 空 = $DSH_HOME/weaver-kb/db（回退 ~/.dsh/weaver-kb/db）
  aliases: {}              # 追加专名表（内置见 src/index.mjs DEFAULT_ALIASES）
```

## 开发

```
pnpm test          # node --test test/*.test.mjs（15 用例：关键词化/命中格式化/节流/检索）
```

结构：`src/recall.mjs`（纯函数，可单测）· `src/search.mjs`（SQLite 检索）· `src/index.mjs`（cordis 入口）。

## 验证（黄金用例）

| 场景 | 期望 |
|---|---|
| 「明日方舟基建」类 | 召回 lore/project |
| 「zstd 会话怎么读」 | 召回 work-skill |
| 闲聊 | 零注入 |
| 代号/专名（P7、ak-tools） | 别名表命中 |
| 子代理任务 | 注入生效且预算减半 |

License: MIT
