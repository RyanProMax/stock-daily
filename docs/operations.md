# Stock Daily 数据与运行策略

## 定时策略

- 触发时间：macOS `launchd` 每天北京时间 `09:00`、`15:00`、`21:00` 生成早间版、A 股收盘版和晚间版；Mac 到点需保持开机。
- 行情：通过 `stock-analysis-api` 无状态 `daily-pack` CLI 一次性读取 S&P 500、
  NASDAQ、DOW、美国 10 年期收益率及中美宽基；不要求 FastAPI 常驻且固定
  `persistence=none`。板块热度仍由日报使用中证全指 11 个一级行业与美国 11 个
  GICS Sector SPDR 计算，主源失败时切换备用源。
- 研究：确定性行情完成后，本机 Codex 根据指数、行业、代表成分股和 AI 产业链的实际强弱，为 CN、US 分别执行收盘、行业异动和 AI 极值三类主动检索；输入不再预选新闻池，也不调用付费搜索 API。
- 来源：搜索结果只用于发现线索。事件或宏观归因必须打开最终原文，核对发布机构、完整时间和正文；政府、交易所及公司公告优先，主流专业媒体次之，专家或社交内容不能单独支撑因果。
- 解读：每个市场必须有结构性盘面解释；只有外部证据与本地行情方向一致时才加入事件或宏观驱动。证据不足时保留结构性结论，不留空、不硬凑新闻。AI 动态同样必须有对应环节行情和直接事件证据。
- 质量门：本机依次审计 CN/US 搜索覆盖并逐一打开所有引用链接，再按 URL 域名确定性核对来源层级，随后校验交易窗口、来源组合、市场归属、数字幅度、单位与涨跌方向。未知域名和社交原帖只能作为专家证据，不能单独支撑因果；任一步失败都停止，不进入发布。
- 增量门：交易日的收盘版要求当日 CN 收盘数据到位；09:00、15:00、21:00 三个主时段各检查一次，同一时段若交易日和更新类型均无推进则跳过研究。数据源延迟时在补偿窗口重试。
- 写入：仅当行情、研究输出和全部本地质量门通过时，才由本机 Wrangler 按日期覆盖 D1；随后必须从生产接口逐项回读一致，才记录本次完成。早间、收盘和晚间更新共用一行，失败不会覆盖上一版内容。

完整任务 prompt、JSON 契约与人工试跑步骤见 [codex-daily-task.md](codex-daily-task.md)。`launchd` 只负责唤醒，Cloudflare 不承载抓取、模型调用或定时调度。

默认要求 `stock-analysis-api` 位于本仓库同级目录。非默认布局通过
`STOCK_ANALYSIS_API_ROOT` 指定 API 仓库绝对路径，通过 `STOCK_ANALYSIS_UV`
指定 `uv` 绝对路径。行情 CLI 失败、返回 `partial` 或六项不完整时整次采集失败，
不会回退到日报内的旧直连实现。

## 最小必要字段

`daily_reports` 只保存：

- 主键与展示元数据：日期、期号、标题、摘要、生成时间、更新类型及 CN/US 各一个行情交易日；
- 溯源元数据：Agent 模型版本；
- 精简 JSON：十项市场指标、CN/US 各十一项一级行业、各八项 AI 产业链篮子，以及中英文市场视图；
- 归因必要字段：每个市场一至三条驱动、恰好一条主驱动、至少一条结构性解释，以及经过验证的直接证据、来源层级、发布时间和传导机制；
- AI 动态：仅保存交易窗口内有直接事件证据的环节更新；没有合格事件时只保存结构性 AI 产业链视图。

不会保存研究查询、查看来源计数、文章全文、网页 HTML、模型 prompt、模型原始响应、token 明细或调试字段。`ingestion_runs` 只记录状态、计数和截断错误，保留 90 天。

## 容量估算

按当前双语日报与周报字段上限保守估算：

- 当前 7 份扩充后日报平均约 `18.12 KiB`，规划按单份双语日报 `20 KiB`、单份双语周报 `12 KiB` 计；
- 一年日报约 `7.13 MiB`，52 份周报约 `0.61 MiB`；
- 计入 SQLite 页、索引、每日最多三条审计及 3 倍增长余量后，约 `24.82 MiB/年`；即使再增长约 50%，也约为 `38 MiB/年`。

该数字是线上数据库存储，不是运行内存；本地开发不保存 D1 副本。

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
