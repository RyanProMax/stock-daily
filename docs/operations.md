# Stock Daily 数据与运行策略

## 定时策略

- 触发时间：macOS `launchd` 每天北京时间 `09:00`、`15:00`、`21:00` 生成早间版、A 股收盘版和晚间版；Mac 到点需保持开机。
- 行情：通过 `stock-analysis-api` 无状态 `daily-pack` CLI 一次性读取 S&P 500、
  NASDAQ、DOW、美国 10 年期收益率及中美宽基；不要求 FastAPI 常驻且固定
  `persistence=none`。板块热度仍由日报使用中证全指 11 个一级行业与美国 11 个
  GICS Sector SPDR 计算，主源失败时切换备用源。
- 新闻：国家统计局、Federal Reserve、SEC、EIA 等官方 RSS 与中美财经源并行发现近 96 小时候选；每个来源独立超时、重试和记录健康状态，不让单点失败拖垮整次采集。
- 解析：RSS/Atom 使用结构化 XML 解析，中文无时区日期按来源时区还原；URL 清理追踪参数，标题使用 Unicode 相似度去重，随后回读原文并用 Readability 提炼最小核验事实。
- 筛选：宏观、指数、利率、能源、关税、财报和大型公司优先；个人理财、荐股、分析师观点、日历、汇总稿、人事变动、软文和标题党直接降权或移除。
- 数量：工作日 CN/US 各 4–6 条，周末各 3–6 条，目标均为 5 条；相关性不足时失败，不为凑数降低事实门槛。
- 解读：顶部定价主线只读取行情；Codex Agent 逐条只读取对应的原始标题与核验事实，输出预期差、市场反应、定价论点、传导链、影响对象、时间范围和核验点。上市对象必须带经事实归属的 ticker 与交易所。“中性”仅用于例行事项、整体稳定或正负因素抵消；信息不足和泛化影响类措辞会被质量门拒绝。最多修正三轮，连续未通过质量门则整次失败。
- 增量门：交易日的 15:00 收盘版要求当日 CN 收盘数据到位，非交易日仍刷新新闻与核验时间；09:00、15:00、21:00 三个主时段各刷新一次，同一时段的补偿重试若交易日与高质量新闻均无推进则跳过 Agent。数据源延迟时在补偿窗口重试。
- 写入：仅当行情、新闻和 Agent 输出全部通过本地校验时，才由本机 Wrangler 按日期覆盖 D1。早间、收盘和晚间更新共用一行，不制造重复期次；失败不会覆盖上一版内容。

完整任务 prompt、JSON 契约与人工试跑步骤见 [codex-daily-task.md](codex-daily-task.md)。`launchd` 只负责唤醒，Cloudflare 不承载抓取、模型调用或定时调度。

默认要求 `stock-analysis-api` 位于本仓库同级目录。非默认布局通过
`STOCK_ANALYSIS_API_ROOT` 指定 API 仓库绝对路径，通过 `STOCK_ANALYSIS_UV`
指定 `uv` 绝对路径。行情 CLI 失败、返回 `partial` 或六项不完整时整次采集失败，
不会回退到日报内的旧直连实现。

## 最小必要字段

`daily_reports` 只保存：

- 主键与展示元数据：日期、期号、标题、摘要、生成时间、更新类型及 CN/US 各一个行情交易日；
- 溯源元数据：Agent 模型版本；
- 精简 JSON：一条结构化定价主线、六条中美行情、CN/US 各三条高波动行业、工作日每个市场 4–6 条候选事实或周末 3–6 条候选事实及英文翻译；
- 信号必要字段：分类、重要度、标题、摘要、最小核验事实、来源与来源层级、发布时间、实际/预期/前值、市场反应、定价论点、传导链、影响对象、时间范围、置信度、核验点，以及已验证的 ticker 与交易所；
- 展示门槛：重要度低于 3 的候选不展示；每个市场最多 3 条核心信号和 2 条辅助信号，排序由重要度、来源层级、预期差、市场反应与实体归属确定。

不会保存文章全文、网页 HTML、模型 prompt、模型原始响应、token 明细、无用指标或逐指标重复日期。`ingestion_runs` 只记录状态、计数和截断错误，保留 90 天。

## 容量估算

按当前双语日报与周报字段上限保守估算：

- 当前 7 份扩充后日报平均约 `18.12 KiB`，规划按单份双语日报 `20 KiB`、单份双语周报 `12 KiB` 计；
- 一年日报约 `7.13 MiB`，52 份周报约 `0.61 MiB`；
- 计入 SQLite 页、索引、每日最多三条审计及 3 倍增长余量后，约 `24.82 MiB/年`；即使再增长约 50%，也约为 `38 MiB/年`。

可运行 `npm run storage:estimate` 复算。该数字是数据库存储，不是运行内存。

## Cloudflare 免费额度判断

当前 Cloudflare 小流量形态预计为 `$0/月`：

- Pages 静态资源请求免费且不计入 Workers 请求；
- SSR 页面和读取 API 消耗 Pages Functions / Workers 请求；本机任务不消耗 Cloudflare 定时器或模型计算额度；
- D1 每天只有少量写入，保守存储约 `24–37 MiB/年`，对个人站点的免费容量仍很宽裕；

Codex Scheduled 的模型使用计入用户现有的 ChatGPT/Codex 方案，不产生 Cloudflare AI 费用；实际可用量取决于用户方案。若站点 API 流量或 D1 用量显著增长，再评估 Workers Paid。

官方参考：

- [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)
- [Pages Functions 定价](https://developers.cloudflare.com/pages/functions/pricing/)
- [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
