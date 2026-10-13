# AGENTS.md（agent 开发须知）

- 零运行依赖：仅 peer cordis / dsh-llm / schemastery；检索用 node:sqlite（Node ≥22.19 / ≥24）。
- 纯逻辑放 recall.mjs（必须可单测）；search.mjs 不得依赖宿主 API；index.mjs 只做接线。
- fail-open 纪律：任何注入路径异常只 warn 不抛出。
- 注入记账：接 `dsh-inject-scheduler` 段 `kr.recall`（order 30 / unit tokens / budget=maxTokensPerTurn），
  经 internal/service 等就绪后注册、注入后上报实际字符数。**调度器是可选依赖，只记账不拦截。**
  改这块先跑 `node --test test/scheduler-metering.test.mjs`（含接线守卫）；判据见 `scripts/verify-scheduler-wiring.mjs`。
- 命中格式前缀 `[knowledge-recall]` 保留（recall.mjs stripBoilerplate 会剥它，防自注入循环）。
- 中文优先注释与 README；改行为先跑 pnpm test。
- 设计文档 docs/design.md 与本文件同步更新。
