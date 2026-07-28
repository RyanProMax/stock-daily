# Stock Daily

一个部署在 Cloudflare Pages、使用 Cloudflare D1 保存历史日报和周报的双语市场备忘录。页面以“本周关键事件 → AI 总览 → 中美市场状态 → 重点新闻 → 其他日报”组织核心信息。

线上地址：[stock-daily-4ip.pages.dev](https://stock-daily-4ip.pages.dev/)

## 功能

- D1 按日期持久化精简日报
- Hono + React 在 Pages 端完成 SSR，首屏 HTML 直接包含 D1 数据
- `/api/reports` 返回日报归档
- `/api/reports/:date` 返回指定日期完整日报
- 首页使用单一日期入口切换期次，并通过归档列表回溯
- 数据库不可用时回退到内置样刊
- Agent 每日解读重点新闻，标注利好/利空、受影响板块与可验证个股
- 采集器按本期期数计算 CN/US 各 3 个一级行业价格热度，SSR 按交易日识别连续高热板块
- 日报顶部按格子展示本周关键事件；只有兑现结果、同一官方来源和核验时间齐全时才标绿打勾
- 市场状态明确显示数据截至今天、昨天或最近交易日的具体收盘日
- 每条新闻保留原始标题、最小核验事实、来源 URL、发布时间和模型版本
- macOS 定时唤醒本机 Codex，每天生成早间版、A 股收盘版与晚间版，每周日生成周报并写入 D1
- 中英文切换、深浅色主题、新闻渐进展开与摘要复制
- 自托管中英文字体与无横向溢出的移动端布局

## 本地开发

```bash
npm install
npm run data:compact
npm run db:migrate:local
npm run pages:dev
```

`npm run dev` 会先构建 Pages Advanced Mode worker，再启动本地 Wrangler。

## 数据更新

macOS `launchd` 每天北京时间 `09:00`、`15:00`、`21:00` 分别生成早间版、A 股收盘版和晚间版：

1. 获取 S&P 500、NASDAQ、DOW、美国 10 年期收益率、上证指数和沪深 300；美股与美债同时比较 FRED 和 Yahoo 的有效数据，逐项选择最新交易日；
2. 并行读取国家统计局、Federal Reserve、BEA、SEC、EIA 等官方发布页或 RSS 与中美财经源；单一来源超时或失败不会阻断其余来源；
3. 结构化解析 RSS/Atom，清理追踪参数并回读原文；正文使用 Readability 提取最小核验事实，事实缺失则不发布；
4. 按中文兼容的标题相似度、URL、来源和主题去重，再剔除个人理财、荐股、标题党、日历与汇总稿等噪声；
5. 工作日每个市场至少 4 条、周末至少 3 条，目标 5 条、最多 6 条；达不到质量下限则整次失败，不用低信号内容凑数；
6. 采集器按中证全指一级行业与美国 GICS Sector SPDR 计算确定性热度，Codex Agent 只生成结构化新闻与市场解读；
7. 指数和行业数据必须属于同一交易日，否则保留上一版并等待重试；交易日的 15:00 收盘版只在当日 CN 收盘数据到位后运行，非交易日仍刷新新闻与核验时间；
8. 三个主时段使用同一 `report_date` 依次覆盖并刷新生成时间，不新增重复期次；同一时段的补偿重试若没有行情或新闻推进则跳过，失败则保留上一版并写入 `ingestion_runs`。

`launchd` 只负责到点唤醒；抓取、AI 解读与质量校验都在本机完成，Cloudflare 不运行抓取或模型任务。本机通过 Wrangler 登录态直写 D1。运行审计保留 90 天，日报长期保留。任务契约和运行前提见 [docs/codex-daily-task.md](docs/codex-daily-task.md)。

手工试跑同一流程：

```bash
npm run daily:collect
# Codex 按 docs/codex-daily-task.md 生成 work/daily-report.json
npm run daily:check
npm run daily:publish
npm run daily:verify
```

手工生成收盘版或晚间版分别使用 `npm run daily:close`、`npm run daily:evening`。
指定日期回补需显式选择 `--update-kind morning`、`--update-kind close`
或 `--update-kind evening`。

每周日北京时间 `20:30` 汇总当周日报，生成基准/上行/下行情景并从官方日历筛选未来一周关键事件。事件公布后，日报仅在同一官方机构的已核验新闻中匹配到结果时展示绿色勾和兑现摘要：

```bash
npm run weekly:run
```

## 构建与测试

```bash
npm test
npm run storage:estimate
npm run security:check
```

## 公开仓库安全

- `.env*`、`.dev.vars*`、Wrangler 本地状态、运行日志、密钥文件与扫描报告默认不进入 Git；
- Cloudflare Account ID 不写入脚本，需要时通过本机环境变量 `CLOUDFLARE_ACCOUNT_ID` 注入；
- `wrangler.jsonc` 中的 D1 `database_id` 是部署绑定标识，不是鉴权凭证；fork 后应替换为自己的数据库 ID；
- GitHub Actions 会对每次 push 与 pull request 执行隐私规则检查和 Gitleaks 全历史密钥扫描；
- 公开仓库应同时启用 GitHub Secret Scanning 与 Push Protection，漏洞通过私有 Security Advisory 报告。

本地安装 Gitleaks 后，可在推送前补跑完整历史扫描：

```bash
gitleaks git --log-opts="--all" --redact --no-banner
```

## Cloudflare 部署

- Pages 项目：`stock-daily`
- D1 数据库：`stock-daily-db`

```bash
npm run db:migrate:remote
npm run deploy
```

详细的数据最小化、容量和成本估算见 [docs/operations.md](docs/operations.md)。

页面内容仅作信息整理与产品演示，不构成投资建议。

## License

本仓库源代码采用 [MIT License](LICENSE)。`data/` 中的第三方新闻、行情数据、商标及来源内容不在 MIT 授权范围内，其权利归相应权利人所有。
