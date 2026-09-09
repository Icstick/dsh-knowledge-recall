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

## 设置页

设置 → 插件 →「知识召回」卡片（Host settings.register + Browser client section，M1 起）：enabled / maxTokensPerTurn / minScore / maxHits / openingScan / subagentBudgetFactor / dbDir。保存 → settings.yaml → 重启生效。aliases/libs 等复杂项仍手改 settings.yaml。

## 配置（settings.yaml namespace knowledge-recall）

```yaml
knowledge-recall:
  enabled: true
  maxTokensPerTurn: 400    # 0 = 关
  minScore: 4              # title 命中≈3；多字段/多词加分（2026-09-09 自检索标定见下）
  loose: true              # CJK bigram 松散匹配（整词失手时按 2-gram 命中率补池，分数×0.8）
  libs: [lore, project, hardware, software-code, software-config, web, work-skill, workflow]
  maxHits: 4
  subagentBudgetFactor: 0.5
  dbDir: ''                # 空 = $DSH_HOME/weaver-kb/db（回退 ~/.dsh/weaver-kb/db）
  aliases: {}              # 追加专名表（内置见 src/index.mjs DEFAULT_ALIASES）
```

## 自检索标定（2026-09-09）

`node scripts/diagnose.mjs --per-lib 40`：对每库抽 40 条条目，用标题前 12 字当查询跑自检索，
量 top-1/top-4 命中率与 rawScore 分布——把 minScore 从"拍"变成"量"。

抽样是**确定性**的（按 id 等距取样，不用 `ORDER BY RANDOM()`）——否则两次运行不可比，
A/B 就变成看噪声。

实测（本机 8 库，n=303）：

| 指标 | 值 |
|---|---|
| top-1 / top-4 命中率 | 44% / 61% |
| rawScore 分布 | p10=1 · **p50=3** · p90=6 · max=14 |
| confidence 覆盖 | 288/303（95%） |
| 超 180 天未更新 | 0/303 |

**读法**：minScore=4 落在分布 p50 之上——纯 title 命中（3 分）会被门槛滤掉。
要提召回，候选动作是把默认降到 3（首轮已用 `max(2, minScore-2)`）；要保精度则维持 4。
**默认值维持 4**（2026-09-09 决策）。
lore 库 top-1 仅 14%（最低），标题偏短、词面重叠高，值得单独看。

### CJK 松散匹配的 A/B（同一批确定性样本）

`--no-loose` 可关掉 bigram 松散匹配做对照：

| | top-1 | top-4 |
|---|---|---|
| `loose: true` | 44% | 61% |
| `loose: false` | 44% | 61% |

**结论要说清楚**：自检索用的是条目**自己的标题**当查询——整词必然命中，
所以这个探针**测不出松散匹配的价值**（它只可能让别的条目挤进候选池，而打折分数排不到前面）。
实测差异只出现在 workflow（82% → 85%，+3pp，属抽样敏感区）。
松散匹配真正的适用场景是**用户措辞与库内标题不同词**（近义/换序），
那需要一个跨词表的探针，目前没有——**这项改动未经效果验证，只是可开关的召回补充**。
不想要就 `loose: false`。

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
