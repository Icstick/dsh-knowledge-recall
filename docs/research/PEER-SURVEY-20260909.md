---
id: DOC-RESEARCH-PEER-SURVEY-20260909
status: draft
surveyed_on: 2026-09-09
scope: dsh-knowledge-recall 同类插件与相邻项目同行调研
---

# dsh-knowledge-recall 同行调研与可吸纳方法（2026-09-09）

## 0. 调研方法与范围

- **时间**：2026-09-09 20:20–21:10（Asia/Shanghai）。星数用 `gh api repos/<owner>/<repo> --jq '.stargazers_count'` 逐个实测，与 `pushed_at` 同批取回；本文件里的数字均为该时刻快照。
- **同行原文**：README 一律走 `gh api repos/<o>/<r>/readme -H "Accept: application/vnd.github.raw"` 落盘后读取（PerryLink/dsh-library 212 行、htcqp802/dsh-knowledge-base 146 行、iwtown/dsh-llm-wiki 162 行、Frog755/dsh-hybrid-memory 114 行、basic-memory 697 行、ReMe 405 行、OpenContext 225 行、两个 Obsidian MCP 全文或结构全扫）。Ansonfishing/dsh-ca-ref 首次取回 EOF，重取成功（73 行）。
- **一手核验（本机源码）**：`packages/llm/llm/src/message.ts`（ContextForm 词表 50–96 行）、`packages/settings/settings/src/index.ts:20`（namespace 正则）、`packages/storage/storage/src/backend.ts:10`（存储域名正则）、`packages/client/ui-chat/src/client/conversation-nodes/message.ts:44–84`（注入消息如何折叠成 context 节点）。
- **本地实测**：用 `node:sqlite` 只读直读 `~/.dsh/weaver-kb/db/*.db`，取 schema、行数、`confidence`/`access_count`/`last_access` 覆盖度（见 §3 第 3 条）。
- **没做**：未安装或运行任何同行插件；未做召回质量对比实验；未读其 issue/PR 与提交历史（ReMe/dsh-ca-ref 只看 README）；未核对 license 兼容性；未联系作者。凡是推断都标了「待核验」。

## 1. 我们的定位（一句话）

把**已经存在**的本地 weaver 8 库（实测 9 846 条）在真实用户回合首步自动召回，命中才注入一段带 `lib/id` 的摘要——不做导入、不做索引、不做嵌入，只做「已有知识的自动取用」，且与 ACP/time-ink 同族共享合计预算护栏。

## 2. 同行地图

| 项目 | ★ | 做什么 | 与我们的关系 |
|---|---|---|---|
| [PerryLink/dsh-library](https://github.com/PerryLink/dsh-library) | 7 | 本地 md/txt → chunk+embed 索引，混合检索 + MMR 去重 + lost-in-the-middle 排序 + 引用校验 + 诊断 | 最近的同生态对标：它管「建库+检索质量」，我们管「自动取用」 |
| [htcqp802/dsh-knowledge-base](https://github.com/htcqp802/dsh-knowledge-base) | 6 | 导入 PDF/docx/md → FTS5(trigram)+BM25 检索 + Web UI 管理 | 中文检索路线的直接参照 |
| [iwtown/dsh-llm-wiki](https://github.com/iwtown/dsh-llm-wiki) | 2 | Obsidian wiki + 管线（lint/okf/compile-patterns）+ 召回热度回写 + 信任分级 | 知识质量闭环的参照 |
| [Frog755/dsh-hybrid-memory](https://github.com/Frog755/dsh-hybrid-memory) | 1 | L1 冻结快照 + L2 一事实一文件 + FTS5（2 字滑窗预分词）+ 审核队列 | 中文分词与「零命中给目录」的参照 |
| [Ansonfishing/dsh-ca-ref](https://github.com/Ansonfishing/dsh-ca-ref) | 1 | 8 个钉版参考仓 → FTS5 库 + 规则清单 + 审查台账 + 命中统计 | 台账/反馈与语料漂移检测的参照 |
| [zhangzhenwen1/qmd-autosearch](https://github.com/zhangzhenwen1/qmd-autosearch) | 1 | 模型 grep/glob 知识库目录时自动补一次语义检索，结果排到 nextStep | 触发式补搜与查询词派生的参照 |
| [ICCuse/dsh-knowledge](https://github.com/ICCuse/dsh-knowledge) | 1 | 桥接全局 Markdown 知识库（与 Codex CLI 共用），写侧字节兼容 | 跨 agent 共用知识库的参照 |
| [PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento) | 105 | 审批门控的跨会话记忆：ctx.memory seam + SQLite + 记忆工具 + 冻结快照注入 | 同生态相邻层：我们读知识库，它管会话记忆 |
| [agentscope-ai/ReMe](https://github.com/agentscope-ai/ReMe) | 3 438 | capture→index→consolidate→recall 四段；auto_dream 生成/佐证/精炼/纠正 digest 节点 | 生态外最强参照：合并与陈旧性治理 |
| [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | 3 905 | Markdown 知识图谱（Observations/Relations）+ 本地 SQLite 索引 + doctor 一致性检查 | 结构化知识 + 健康检查的参照 |
| [0xranx/OpenContext](https://github.com/0xranx/OpenContext) | 814 | 个人上下文库 + CLI/MCP/Skills，`oc context manifest` 生成给 AI 读的清单 | 「给模型一张库地图」的参照 |
| [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | 675 | Obsidian 笔记的读写/检索/局部编辑，含 document-map 与三种检索模式 | 检索模式与路径权限模型的参照 |
| [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | 4 378 | 极简 Obsidian MCP（列目录/取内容/搜索/局部 patch） | 最小可用面的对照 |
| [zilliztech/memsearch](https://github.com/zilliztech/memsearch) | 2 579 | Markdown + Milvus 的跨 agent 记忆层 | 生态外「上向量」的路线对照 |

## 3. 可吸纳的方法（核心）

### 🔴 P0-1 用 FTS5 trigram tokenizer 补中文分词
- **出处**：htcqp802/dsh-knowledge-base README「FTS5 full-text search — SQLite FTS5 (trigram tokenizer, no Chinese segmentation needed) + BM25 relevance ranking；falls back to LIKE for short queries or anomalies」（[repo](https://github.com/htcqp802/dsh-knowledge-base)）；同问题另一解法见 Frog755/dsh-hybrid-memory「FTS5 的 unicode61 不切中文，插件在写入索引前用 2 字滑窗预分词」。
- **它怎么做**：建 FTS5 时显式指定 trigram 分词器，中文无需分词即可做子串/词级匹配并拿到 BM25 打分；短查询与异常回退 LIKE。
- **我们现状**：弱。`src/search.mjs:67-76` 的 `entries_fts MATCH` 只对**纯拉丁词**触发（`src/search.mjs:109` 的 `/^[A-Za-z]/` 判断），中文 100% 走 4 字段 LIKE 子串；`docs/design.md` 已把「FTS 中文分词弱」列为 M2 待办。实测本机 weaver 的 `entries_fts` 是默认分词器（`sqlite_master` 里无 tokenize 参数）。
- **建议**：不动 weaver 的共享库，在本插件自有 storage 里建 title/summary/tags 的 trigram 影子索引（或先只做「查询词 bigram 分解 + LIKE 计数」的过渡版）作为 M2 第一项。

### 🔴 P0-2 自检索/诊断指标，把 minScore 从猜测变成数据
- **出处**：PerryLink/dsh-library 的 `library_diagnose`：chunk 尺寸直方图、近重复 chunk 对、**self-retrieval probe**、middle-penalty 信号（[README「What you get」](https://github.com/PerryLink/dsh-library)）。
- **它怎么做**：用库内内容构造探针查询，测「拿这条内容当查询能不能召回它自己」，用命中率当检索质量的客观指标；把阈值调参建立在这条曲线上。
- **我们现状**：弱。`src/index.mjs:41` 的 `minScore` 默认 4 是初值，`docs/design.md`「已知边界」自己写着「需真实消息语料标定」；测试只有 `test/golden-offline.mjs` 等少数用例，没有量化指标。
- **建议**：加 `scripts/diagnose.mjs`：以每个库的 title 前 12 字为查询跑 self-retrieval，输出各库 top-1/top-4 命中率与 score 分布，用它定 minScore 与 perTermPerLib。

### 🔴 P0-3 用上我们已有却完全没读的字段：confidence / updated_at
- **出处**：weaver 自身的 `entries` schema（本机实测）与 `plugins/dsh-weaver/index.mjs:36,119`（`weaver_search` 已把 `confidence` 展示给模型）。
- **它怎么做**：weaver 检索结果本来带 `confidence` 与 `created_at/updated_at`；dsh-library 与 dsh-llm-wiki 都给了「按可信度/新鲜度调权」的样例（后者用 quality_score + verified 分级影响召回）。
- **我们现状**：没有。`src/search.mjs:43-47` 只 SELECT id/title/summary/tags/body；打分只有字段权重（`FIELD_WEIGHT`，35 行）。实测 `confidence<1.0` 的条目占比很高（hardware 234/288、project 78/472、work-skill 59/107），这些低置信条目现在与 1.0 条目同权竞争。
- **建议**：score 乘/加 confidence 权重，并在注入行尾附 `conf=0.8 · 更新于 2026-08-30`，让模型自己知道这条有多新多稳。

### 🔴 P0-4 把「陈旧性」变成注入里的一个字段
- **出处**：[你的智能体记忆需要两个时钟](https://tianpan.co/zh/blog/2026-07-02-your-agents-memory-needs-two-clocks)（valid time / transaction time；「当检索到的事实进入上下文窗口时，包含它被观察的时间及其有效性状态（"14 个月前观察到，此后未验证"）」）；ReMe 的 auto_dream 把新事实与既有 digest 的关系分为 create/corroborate/refine/**correct**（[README「Memory Lifecycle」](https://github.com/agentscope-ai/ReMe)）。
- **它怎么做**：事实带观测时间与有效期，取代关系用「关闭区间 + 追加继任者」表达；检索默认给「当前有效且当前已知」，并在上下文里显式标注陈旧度，把「知道某条记忆已失效」从推理问题降级为过滤问题。
- **我们现状**：没有。注入行只有 `lib/id《title》：summary`（`src/recall.mjs:151`），模型无从判断这是三天前还是三个月前的经验；weaver 也没有 supersede 关系。
- **建议**：注入行附更新时间与「未复核」标记，并对 `updated_at` 超过阈值（如 180 天）的条目降权或降级显示——注意实测 `updated_at` 有三种格式（ISO 带 Z / ISO 不带 Z / epoch 如 `1784013556`，见 §0 实测），解析要先兼容。

### 🟠 P1-1 零命中时也给一张极短的「库目录」
- **出处**：Frog755/dsh-hybrid-memory「首步无命中时注入记忆库目录（最新事实标题），让模型"读过"记忆库、知道可以主动 memory_search」；OpenContext 的 `oc context manifest <folder>`「Generate file list for AI to read」；cyanheads/obsidian-mcp-server 的 `format: "document-map"`（标题/块引用/frontmatter 字段目录）。
- **它怎么做**：命中为空不等于无事可做——给模型一份可读的清单，它就知道下一步该主动查什么。
- **我们现状**：弱。`src/index.mjs:126` 命中 0 条直接 `return decision`（0 命中 0 token，这是优点），但模型因此完全不知道库里还有 9 846 条。`openingScan` 只放宽了阈值，没有目录兜底。
- **建议**：首回合零命中时注入 ≤3 行「库目录」（按 lib 分组的最新/最高置信标题），硬上限 60 token。

### 🟠 P1-2 结果集去重与多样性（MMR）而不是纯分数排序
- **出处**：PerryLink/dsh-library `search.diversityLambda`（MMR：1=纯相关，0=纯多样）与 `lostMiddleHead/Tail`（最强块钉在头尾）。
- **它怎么做**：先按相关度取候选，再做最大边际相关重排，避免近重复条目霸占结果页；最强内容放两端对抗 lost-in-the-middle。
- **我们现状**：弱。`src/search.mjs:134-136` 只做 `filter(minScore) → sort(score) → slice(maxHits)`；同一库的近重复条目（例如同一经验的多个版本）会同时占掉 4 个名额。
- **建议**：加「每库 ≤2 条 + 标题相似度去重」的轻量版；注入在尾部，middle 问题对我们不适用，不必抄排序。

### 🟠 P1-3 节流状态改为可从日志重建
- **出处**：官方 `@deepseek-ai/dsh-time-context` 用 `ctx.sessionProjections.register` 折叠 `lastInjectionTime`，并在间隔分支扫原始会话事件（本机 `packages/context/time-context/src/index.ts:152-178`）。
- **它怎么做**：把「上次注入了什么/什么时候」做成从持久事件折叠出来的投影，重启、resume、fork 之后依然成立，不依赖进程内缓存。
- **我们现状**：弱。`src/recall.mjs:166-178` 的 `RecallThrottle` 是进程内 `Map`，重启即忘；Dsh 重启后同会话同命中集合会再注入一次。
- **建议**：至少把节流签名落到 storage（或 session projection），或在 README 明确「重启后可能重复注入一次」。

### 🟠 P1-4 命中反馈闭环（usage ledger）
- **出处**：iwtown/dsh-llm-wiki「闭环：使用数据（recall 命中）→ queried_count → quality_score → 影响召回 → verified 信任分级」；Ansonfishing/dsh-ca-ref「审查台账…命中统计反哺参考库策展」。
- **它怎么做**：把「哪条知识被召回/被引用」记下来，反过来影响排序与策展决策。
- **我们现状**：没有。实测 weaver 的 `access_count` 与 `last_access` 两列**全库为 0 且无任何写入方**（`plugins/dsh-weaver/index.mjs` 只读不写）——字段是死的。
- **建议**：本插件自有 ledger（storage domain，域名用下划线如 `knowledge_recall`）记 `(session, query, hit ids)` 计数，M2 用于排序或「常被召回」标记；**不要**回写 weaver 库。

### 🟡 P2-1 查询词派生加「短消息/闲聊」回退
- **出处**：zhangzhenwen1/qmd-autosearch「以最近的用户消息（任务要求）为语义主查询；消息过短或与搜索主题无关时，回退使用 grep pattern」。
- **它怎么做**：把「用户到底在问什么」当主查询，工具 pattern 只当兜底。
- **我们现状**：部分具备。`src/recall.mjs:91-139` 已从最后一条真实用户消息取词（含别名表、CJK 滑窗、引导词剥离），但 CJK 段 <4 字直接丢弃、无「太短就合并上一条消息」的回退。
- **建议**：短消息（<8 字或词数 0）时合并会话最近两条真实用户消息再取词。

### 🟡 P2-2 声明 source 的 `form`，别让 UI 走 opaque 分支
- **出处**：DSH `ContextForm` 词表（`packages/llm/llm/src/message.ts:50-96`：instructions/catalog/snapshot/notice/relay/recall）与 `packages/client/ui-chat/src/client/chat/ContextBody.tsx:388-411`（snapshot 有专门渲染）。
- **它怎么做**：注入消息除 `kind:'plugin', plugin` 外可声明 `form`（recall 需配语义），UI 按 form 选正文渲染；未声明或未知值按 opaque 呈现。
- **我们现状**：未声明。`src/index.mjs:141` 只有 `{ kind: 'plugin', plugin: PLUGIN }`。折叠行本身没问题（`message.ts:55-64`：source.kind!=='user' 即折叠成 context 节点），但展开后的正文是「一团不透明的文本」。
- **建议**：改声明 `form: 'recall'`；同时注意词表是**语义**词表，不要自造值（本工作区已有 `form:'pin'`、`form:'work-state'` 这类自造值，属于越界用法，待核验其升级风险）。

### 🟡 P2-3 KB 健康检查与 schema 漂移检测
- **出处**：basic-memory `basic-memory doctor`（file ↔ DB 一致性检查）；dsh-llm-wiki `--lint`（frontmatter 完整性 + 孤立节点 + stale 报告）；dsh-ca-ref「每日 tick 用 `git rev-parse HEAD` 只读校验钉版 SHA，漂移时面板标 ⚠️，不自动 re-clone」。
- **它怎么做**：把「源与索引是否一致、语料是否漂移」做成一条可定时跑的命令，而不是出事再查。
- **我们现状**：没有。实测已发现 schema/格式漂移：`workflow.db` 的 `updated_at` 是 epoch 秒、`lore.db` 缺 `Z` 后缀；README 写「800+ 条目」而实测 9 846 条。
- **建议**：`scripts/doctor.mjs` 检查 8 库表结构、时间格式、行数，并修正 README 的条目数。

## 4. 印证我们判断的地方

- **命中才注入、预算硬上限**：dsh-library 有 `injection.maxChars` 与 `search.maxResultChars`；qmd-autosearch 有 `minScore`（默认 25）与 `limit`。与我们 `maxTokensPerTurn` + 合计 900 token 护栏同向。
- **fail-open**：qmd-autosearch「QMD 服务不可用或查询无结果时静默跳过，不影响原流程」；我们 `src/index.mjs:143-147` 同纪律。
- **直读本地 SQLite 而不是走工具**：dsh-ca-ref 把 8 个参考仓预索引成本地 FTS5 库；basic-memory 用本地 SQLite 索引 Markdown 源；dsh-hybrid-memory 用 `node:sqlite`。我们的 `search.mjs` 直读 weaver 库属于同一族。
- **中文靠 LIKE/trigram 而不是等分词器**：htcqp802 明确用 trigram；Frog755 用 2 字滑窗预分词。我们「中文靠 LIKE 子串」是同一现实的第三种妥协。
- **注入用 append + source 标记**：官方 `time-context` 与 `session-reference` 都走 `agent/pre-step` append + 显式 source（本机源码），与本插件一致。

## 5. 我们不该学的

- **不上嵌入/向量**。dsh-library 自己承认内置 hash embedding「scores surface similarity, not meaning」；basic-memory 的语义检索要 FastEmbed 模型下载或 LiteLLM；ReMe 的向量是可选项但要 embedding API。我们的核心价值是零依赖零下载——为了「语义」把依赖面拉大，等于换一个产品。
- **不做文档导入管线**。htcqp802 的 PDF/docx 解析、chunk 合并、upsert、Web 文件管理器是一整套产品面；weaver 已有自己的写入侧，我们重复建设没有收益。
- **不做常驻全量注入**。basic-memory 的 L1 冻结快照适合几十条精选事实；我们有 9 846 条，常驻会直接吃掉上下文预算。首回合目录兜底必须极短。
- **不回写 weaver 库**。`access_count/last_access` 虽然是死列，但跨插件写共享 SQLite 有并发与归属风险（weaver 未提供写入 API）——用我们自己的 ledger。
- **不把 fail-open 无差别套到「配置了却没生效」上**。basic-memory 的做法相反：「enabled provider fails 不静默回退到检索顺序」。我们要区分「未启用」与「启用但检索失败」——后者应 warn 到可见位置，否则调参时看不出问题。

## 6. 落地建议（最多 3 条）

1. **`scripts/diagnose.mjs` 自检索标定（半天）**：输出各库 top-1/top-4 self-retrieval 命中率与 score 分布，用数据定 `minScore`/`perTermPerLib`。投入最小、直接解掉「默认值靠猜」。
2. **注入行加 confidence + 更新时间（1 天）**：读已有字段、加权、格式化输出；不改索引、不引依赖，模型立刻多两个质量信号。
3. **trigram 影子索引（1–2 天）**：在自有 storage 建 title/summary/tags 的 trigram FTS5，中文从子串匹配升级为词级 + BM25，替换现在的 LIKE 主路径。

## 7. 来源清单

**原文（一手，2026-09-09 抓取）**

- https://github.com/PerryLink/dsh-library — README 全文（★7）
- https://github.com/htcqp802/dsh-knowledge-base — README 全文（★6）
- https://github.com/iwtown/dsh-llm-wiki — README 全文（★2）
- https://github.com/Frog755/dsh-hybrid-memory — README 全文（★1）
- https://github.com/Ansonfishing/dsh-ca-ref — README 全文 + `git/trees` 目录树（★1）
- https://github.com/zhangzhenwen1/qmd-autosearch — README 全文（★1）
- https://github.com/ICCuse/dsh-knowledge — README 全文（★1）
- https://github.com/PerryLink/dsh-memento — 仓库元数据（★105）
- https://github.com/agentscope-ai/ReMe — README 关键章节（★3 438）
- https://github.com/basicmachines-co/basic-memory — README 全文（★3 905）
- https://github.com/0xranx/OpenContext — README 全文（★814）
- https://github.com/cyanheads/obsidian-mcp-server — README 结构 + 工具清单（★675）
- https://github.com/MarkusPfundstein/mcp-obsidian — README 前段（★4 378）
- https://github.com/zilliztech/memsearch — 仓库元数据（★2 579）
- https://tianpan.co/zh/blog/2026-07-02-your-agents-memory-needs-two-clocks — 全文（双时态/陈旧性）
- 本机 `D:\deepseek-harness`：`packages/llm/llm/src/message.ts`、`packages/client/ui-chat/src/client/chat/ContextBody.tsx`、`packages/client/ui-chat/src/client/conversation-nodes/message.ts`、`packages/context/time-context/src/index.ts`、`packages/settings/settings/src/index.ts`、`packages/storage/storage/src/backend.ts`
- 本机 `~/.dsh/weaver-kb/db/*.db`（node:sqlite 只读直读：schema、行数、字段覆盖度）
- 本机 `D:\DSH_workspace\plugins\dsh-weaver\index.mjs`（confidence 读取面）

**二手（仅作线索，未逐字核验）**

- https://deepwiki.com/microsoft/skills-for-copilot-studio/6.4-date-context-injection — 仅用于交叉参考（本文件未采纳其结论）
- ReMe 的 LongMemEval/BEAM/π-Bench 分数（README 自述，未复现）
