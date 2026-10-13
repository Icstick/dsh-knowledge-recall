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
- 追加 `createUserMessage`，source = {kind:'plugin:dsh-knowledge-recall'}（可审计、UI 折叠、不干扰前缀缓存——消息在尾部）；
- 文本格式每条约 220 字符：`[knowledge-recall] weaver <lib>/<id>《title≤60》：summary≤160`；
- 预算：maxTokensPerTurn（默认 400）×2 字符估算；合计护栏 TOTAL_INJECT_BUDGET_TOKENS=900（与 ACP/memento 等注入字符合计）；
- 节流：RecallThrottle 同会话同命中签名不重复注入；
- 子代理（delegationDepth>0）：预算 ×subagentBudgetFactor（0.5）。

## 注入记账（2026-10-04）
接 `dsh-inject-scheduler`（方案 A：注入方主动上报），与 dsh-adaptive-context / dsh-work-continuity 同形：
- 注册段 `kr.recall`（plugin=dsh-knowledge-recall，order=30，unit=tokens，budgetChars=maxTokensPerTurn，refresh=per-turn）；
- 经 `withService(ctx,'injectScheduler',…)` 在**服务就绪事件**后注册——本插件在 bundles 里排在调度器之前，
  apply 时服务通常还没 provide；调度器是可选依赖，缺失/故障只降级日志；
- 每次真正 push 进 decision 后 `reportRecallUsage(ctx, sessionId, out.text)`，记实际字符数；
- 该接线**只记账、不拦截**：不改注入时机、内容与预算判定，接上前后注入行为逐字节相同。
- 判据：`scripts/verify-scheduler-wiring.mjs`（读 `$DSH_HOME/storages/inject_scheduler.json`，可复跑）。

## 语义补充（2026-10-13，自云端 C 收回）
关键词路径的死角：库内以中文为主，FTS5 unicode61 把长串中文当一个 token —— 措辞与库内标题不同词就是零命中。
- 触发：`cfg.semantic !== false` 且 `hits.length < max(1, semanticFallbackBelow)`（默认 2）；抽词为空时**不再早退**
  （语义不吃抽词这一步，短查询/纯专名正是关键词的死角），`semantic === false` 时保持原早退行为一字不变；
- 取数：`search.mjs` 的 `semanticSearch(query, {endpoint, libs, maxHits, minScore, timeoutMs, strengthFn, onWarn})`
  —— **只认 endpoint 字符串，不吃 ctx**（search.mjs 不得依赖宿主 API）；`fetch` + `AbortSignal.timeout`，整句原样送 `GET /search`；
- 合并：`mergeHits(kw, sem, max)` —— 关键词原序在前，语义按相似度接在后补空位，同 `lib:id` 去重；
  两路分制不同（词面分 vs 余弦×10），故**不比分数**，只靠顺序；
- fail-open：服务不在 / 超时 / 非 200 / 非 JSON / `ok:false` → 空数组 + 一行 warn，注入退回关键词一路；
- **默认关**：本仓 `Config.semantic` 默认 `false`。服务端（`~/cloud_workspace/embed/service.py`，systemd
  `semantic-search.service`，127.0.0.1:8765，bge-small-zh-v1.5 ONNX/CPU）**不在本仓，且只部署在 C 上**；
  A/B/W 默认开会给每次召回白加一次超时尝试。C 侧部署副本仍是 `true`，不受本仓默认值影响。
- 判据：`node --test test/semantic.test.mjs`（16 例，假服务走 `listen(0)` 临时端口，不依赖真 8765 在线）。

## 关键词化（recall.mjs extractKeywords）
1. 剥样板（[acp:…] 行、system-reminder、[work-state]、历史 [knowledge-recall]）；
2. 别名命中（内置 DEFAULT_ALIASES + 配置追加；CJK key=includes，拉丁 key=词边界）→ 值空格分词入词表；
3. 拉丁词（≥3 字符、去停用表、跳过已别名命中的 key）；
4. CJK 连续段：4~12 字整段；>12 字滑窗（前 12 + 8 步进）；
5. 总量 ≤ maxTerms（默认 6）。

## 实施状态
- M0（2026-09-08）：repo 骨架/关键词化/LIKE+FTS 检索/pre-step 注入/预算护栏/节流；单测 15 → 端到端验证通过（真实提问精确命中 wv-20260902-004）
- M3（2026-10-13）：语义补充自云端 C 收回本仓（Config 五项 + `semanticSearch` + `mergeHits`）；
  **默认 `semantic: false`**（服务端只在 C 上）；`test/semantic.test.mjs` 16 例，全量 80 例通过
- M1（2026-09-08）：openingScan 开场宽检索（首回合词数 12/阈值 -2）；delegationDepth 修正（session.header.delegationDepth，源码核实）；host settings.register + settings.yaml 合并；client 设置页 section（build:client → lib/client.js）；CJK 引导词剥离（CJK_LEAD）；单测 18

## 已知边界（M2 待办）
- FTS 中文分词弱 → 中文依赖 LIKE 子串（召回够用、精度靠 minScore）；
- minScore 默认 4 为初值，需真实消息语料标定（G4 代号类噪声：库缺内容 + 泛词，观察记录中）；
- aliases/libs 等复杂配置项暂无 UI（settings.yaml 手改）；
- 注入第三条噪声观察：settings 卡片词法误命中相关度一般条目（调优随 M2）；
- 语义补充的**效果未经本机标定**：A/B/W 无 8765 服务，无法在本地量它对召回率的贡献；阈值（0.42）与
  回退线（2）沿用 C 侧经验值，未在本仓样本上复核。跨机能力不对齐本身见 `docs/ops/semantic-port-20261013.md`。
