# dsh-knowledge-recall 设计（repo 内摘要）

> 完整设计定稿：DSH 工作区 `docs/plans/weaver-knowledge-recall-20260908.md`（v1）
> 状态：M0 ✅（2026-09-08 端到端验证通过）· M1 ✅（openingScan/设置页/depth 修正/CJK 剥离）· M2 待排
> 全案计划：`docs/plans/knowledge-flow-plan-20260908.md`
> 本文档 = repo 内维护的机制说明（与 AGENTS.md 同步更新）。

## 目标
真实用户消息到达 → 自动召回本地 weaver 知识（8 库 SQLite 直读）→ 高置信条目摘要注入（命中才注入、预算可控、主/子代理通吃、fail-open）。

## 为什么直读 SQLite
插件运行在宿主进程，不能调用注册给模型的工具（weaver_search）。检索实现：
- 词化后对每库 `entries` 做 `title/summary/tags/body` LIKE 加权（title 3 / tags 2 / summary 2 / body 1）；
- 纯拉丁词无 LIKE 命中时补 `entries_fts` FTS5 前缀匹配（score≈4）；
- 任一库缺失/损坏静默跳过；整体 minScore 过滤 + 排序截断。

## 注入协议
- 挂 `agent/pre-step` waterfall：`await next()` 拿到完整决策后，仅 step===1、kind==='enter'、含真实用户消息时工作；
- 追加 `createUserMessage`，source = {kind:'plugin', plugin:'dsh-knowledge-recall'}（可审计、UI 折叠、不干扰前缀缓存——消息在尾部）；
- 文本格式每条约 220 字符：`[knowledge-recall] weaver <lib>/<id>《title≤60》：summary≤160`；
- 预算：maxTokensPerTurn（默认 400）×2 字符估算；合计护栏 TOTAL_INJECT_BUDGET_TOKENS=900（与 ACP/memento 等注入字符合计）；
- 节流：RecallThrottle 同会话同命中签名不重复注入；
- 子代理（delegationDepth>0）：预算 ×subagentBudgetFactor（0.5）。

## 关键词化（recall.mjs extractKeywords）
1. 剥样板（[acp:…] 行、system-reminder、[work-state]、历史 [knowledge-recall]）；
2. 别名命中（内置 DEFAULT_ALIASES + 配置追加；CJK key=includes，拉丁 key=词边界）→ 值空格分词入词表；
3. 拉丁词（≥3 字符、去停用表、跳过已别名命中的 key）；
4. CJK 连续段：4~12 字整段；>12 字滑窗（前 12 + 8 步进）；
5. 总量 ≤ maxTerms（默认 6）。

## 实施状态
- M0（2026-09-08）：repo 骨架/关键词化/LIKE+FTS 检索/pre-step 注入/预算护栏/节流；单测 15 → 端到端验证通过（真实提问精确命中 wv-20260902-004）
- M1（2026-09-08）：openingScan 开场宽检索（首回合词数 12/阈值 -2）；delegationDepth 修正（session.header.delegationDepth，源码核实）；host settings.register + settings.yaml 合并；client 设置页 section（build:client → lib/client.js）；CJK 引导词剥离（CJK_LEAD）；单测 18

## 已知边界（M2 待办）
- FTS 中文分词弱 → 中文依赖 LIKE 子串（召回够用、精度靠 minScore）；
- minScore 默认 4 为初值，需真实消息语料标定（G4 代号类噪声：库缺内容 + 泛词，观察记录中）；
- aliases/libs 等复杂配置项暂无 UI（settings.yaml 手改）；
- 注入第三条噪声观察：settings 卡片词法误命中相关度一般条目（调优随 M2）。