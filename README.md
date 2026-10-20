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
- 外部 Agent 可通过带鉴权、幂等与版本保护的 API 更新日报/周报（旧本地调度待验收切换）
- 中英文切换、深浅色主题、新闻渐进展开与摘要复制
- 自托管中英文字体与无横向溢出的移动端布局

## 本地开发

```bash
npm install
npm run pages:dev
```

`npm run dev` 会使用 `wrangler.jsonc` 中不含 D1 绑定的本地配置启动 Worker。本地 SSR 和 `/api/*` 均通过线上只读 API 获取生产数据，不创建、迁移或同步本地数据库；只有生产环境配置保留 D1 绑定。线上数据不可用时本地会返回明确错误。

## 数据更新

新的外部 Agent 路径：dot / Grokbot 在仓库外研究并生成最终日报/周报，通过受鉴权的 PUT 写入 D1，再从生产 GET 回读确认。服务端仅校验、存储和展示，不运行采集、模型或定时任务。

- 最终契约与合成例子：[docs/report-contracts/](docs/report-contracts/README.md)
- 更新 Skill：[maintain-stock-daily](.agents/skill/maintain-stock-daily/SKILL.md)
- 日报：`GET/PUT /api/reports/:date`；周报：`GET/PUT /api/weekly/:weekEnd`
- PUT 需要应用级 Bearer 凭据、`Idempotency-Key` 及创建/更新版本条件；Agent 不需要 SQL 或 Cloudflare 管理权限。
- JSON Schema 是校验与渲染适配的共同来源；修改契约后运行 `npm run contracts:generate`，构建会检查类型声明漂移。
- 历史内容不批量重写，现有双语、中美、行业与 AI 页面继续使用。

这是本地第一阶段改造。现有 main 的 launchd 仍引用旧生成链路，因此本分支暂留原脚本、依赖与测试；尚未切换生产调度或创建真实凭据。部署迁移、验收、停用旧任务及后续删除顺序见[迁移说明](docs/report-contracts/MIGRATION.md)。GitHub Actions 仍负责构建测试与安全扫描。

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
