# Stock Daily

一个部署在 Cloudflare Pages、使用 Cloudflare D1 保存历史日报和周报的双语市场备忘录。页面以“市场快照 → 定价信号板 → 往期日报”组织核心信息。

线上地址：[stock-daily-8k4.pages.dev](https://stock-daily-8k4.pages.dev/)

## 功能

- D1 按日期持久化精简日报
- Hono + React 在 Pages 端完成 SSR，首屏 HTML 直接包含 D1 数据
- `/api/reports` 返回日报归档
- `/api/reports/:date` 返回指定日期完整日报
- 首页使用单一日期入口切换期次，并通过归档列表回溯
- 本地 SSR 与本地 API 直接读取线上只读数据，不创建本地 D1 或报告镜像
- 本地隔离研究固定覆盖大盘、11 个行业、8 个 AI 环节，核实方向、传导及涨跌幅受限或放大；所有目标通过证据和独立复核后才发布
- 采集 CN/US 各 11 个一级行业、代表股和各 8 个 AI 产业链环节的收盘行情
- 日报顶部按格子展示本周关键事件；只有兑现结果、同一官方来源和核验时间齐全时才标绿打勾
- 市场状态显示明确的本地化收盘日期，历史日报不会把旧行情称为今天
- 每条新闻保留原始标题、最小核验事实、来源 URL 和发布时间
- macOS 定时唤醒本机 Codex，每天生成早间版、A 股收盘版与晚间版，每周日生成周报并写入 D1
- 中英文切换、深浅色主题、新闻渐进展开与摘要复制
- 自托管中英文字体与无横向溢出的移动端布局

## 本地开发

```bash
npm install
npm run pages:dev
```

`npm run dev` 会使用 `wrangler.jsonc` 中不含 D1 绑定的本地配置启动 Worker。本地 SSR 和 `/api/*` 均通过线上只读 API 获取生产数据，不创建、迁移或同步本地数据库；只有生产环境配置保留 D1 绑定。线上数据不可用时本地会返回明确错误。

## 数据更新

macOS `launchd` 每天北京时间 `09:00`、`15:00`、`21:00` 分别生成早间版、A 股收盘版和晚间版：

1. 通过一次性
   `stock-analysis-api/scripts/market_data_query.py daily-pack` 获取 S&P 500、
   NASDAQ、DOW、美国 10 年期收益率、上证指数和沪深 300；无需启动 FastAPI，
   固定无持久化，并由 API 统一比较 FRED / Yahoo 与中国指数 fallback；
2. 确定性程序整理指数、一级行业、代表股与 AI 产业链的真实异动；Planner 只据此提出研究问题，不把涨跌事实当作原因；
3. 每个异动并行启动互不可见的事实研究与因果研究进程，主动检索公告、财报、市场预期、收盘报道和竞争解释；
4. 程序重新打开最终来源正文，核实页面发布时间与精确摘录。财报数据必须包含类型化实际值、预期值和程序计算的差额；
5. 独立裁决、成稿、复核和翻译分别使用新的临时 Agent。任何阶段证据不足时不生成凑数卡片；
6. CN、US 按收盘日独立更新。发布只替换当前市场切片，另一市场已验证内容保持不变；
7. 所有断点均为忽略版本控制的临时 JSON，不创建本地数据库；
8. 写入 D1 后必须从线上 API 回读并比较内容哈希，完全一致才标记完成。

`launchd` 只负责到点唤醒；抓取、AI 解读与质量校验都在本机完成，Cloudflare 不运行抓取或模型任务。本机通过 Wrangler 登录态直写 D1。运行审计保留 90 天，日报长期保留。任务契约和运行前提见 [docs/codex-daily-task.md](docs/codex-daily-task.md)。

行情 Skill 默认使用同级目录 `../stock-analysis-api`，并从常见安装位置解析
`uv`。目录或可执行文件不在默认位置时，在本机环境设置绝对路径：

```bash
STOCK_ANALYSIS_API_ROOT="/absolute/path/to/stock-analysis-api"
STOCK_ANALYSIS_UV="/absolute/path/to/uv"
```

手工试跑同一流程：

```bash
npm run daily:shadow  # 完整运行但不发布
npm run daily:run     # 只运行并发布 US
npm run daily:close   # 只运行并发布 CN
npm run daily:check   # 校验最近一次运行清单与报告
npm run daily:verify  # 重新回读线上当前市场切片
```

定向核验或发布已审核成稿时，显式指定该次运行的 `manifest.json`，输入和报告路径会从清单读取：

```bash
npm run daily:check -- --require-complete --manifest work/runs/RUN_KEY/manifest.json
npm run daily:publish -- --manifest work/runs/RUN_KEY/manifest.json
```

手工发布和调度共用发布恢复与批次完成逻辑；只有正式发布模式且通过全部板块复盘验收的成稿可写入，影子报告和旧版简略报告会被拒绝。普通检查会单独返回完整复盘是否通过及其目标数量，不能把旧版结构有效当作完整复盘验收。旧流程验证见 [历史验收记录](specs/verified-recap-workflow/acceptance.md)，完整板块复盘实跑与页面验收见 [完整复盘验收记录](specs/complete-sector-recap/acceptance.md)。

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
