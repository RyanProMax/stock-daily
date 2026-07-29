# Stock Daily 本机 Codex 日报任务

这是本机 Codex 日报的持久任务说明。macOS `launchd` 只负责到点唤醒，`codex exec` 负责 AI 解读；Cloudflare 只提供 D1 存储和 Pages 读取接口。

## 每次运行的完整指令

完整包装流程由 `scripts/run-codex-daily.sh` 执行：

1. `npm run daily:collect` 把最小必要行情、CN/US 一级行业热度与候选新闻写入被 git 忽略的 `work/daily-input.json`。采集器并行运行独立来源适配器，结构化解析 RSS/Atom、BEA 官方发布页或来源 API，按 URL、Unicode 标题相似度、来源和主题去重，再回读原文提炼 `facts`。历史回补使用人工审计的同结构事实摘要；正文抓取或事实摘要缺失时淘汰该候选，由下一条高分候选递补。
2. 定时运行先执行 `npm run daily:freshness`。交易日收盘版要求当日 CN 收盘数据已到位，非交易日仍刷新新闻与核验时间；三个主时段各刷新一次，只有同一时段的补偿重试在两个市场交易日和高质量新闻均未推进时才直接跳过、不调用 Agent。
3. 本机 `codex exec` 读取 `docs/codex-daily-agent-prompt.md` 和输入，独立完成中英双语总览、CN/US 分市场总览及逐条新闻解读，写入 `work/daily-report.json`。
4. Codex 内部和包装脚本各执行一次 `npm run daily:check`。若质量门失败，Codex 最多修正三轮；禁止通过放宽或删除校验绕过问题。
5. 质量门通过后，包装脚本运行 `npm run daily:publish`，使用本机 Wrangler 登录态按 `report_date` 覆盖写入远程 D1，并保留最小运行审计。
6. `npm run daily:verify` 回读线上 health 与当日日报，确认日期、更新类型、分市场行情日期、数量、`isSample` 和 Codex 溯源字段一致。

Codex 运行在 `workspace-write` 沙箱中，只允许修改 `work/daily-report.json`，不访问网络、不改源代码、不提交 git、不部署 Pages。确定性包装脚本负责联网采集和最终入库，页面会直接读取 D1 的新记录。

## Agent 输出结构

`work/daily-report.json` 必须是以下结构，不增加字段：

```json
{
  "headline": "8–22 个汉字的具体标题，不含数字",
  "summary": "20–88 个汉字的完整句子",
  "overview": {
    "tone": "positive | negative | mixed",
    "interpretation": "42–180 个汉字，只依据 markets，明确利好/利空与传导机制",
    "positive": ["0–4 个主要受益市场或板块"],
    "negative": ["0–4 个主要承压市场或板块"]
  },
  "marketViews": {
    "CN": {
      "headline": "只依据 region=CN 行情生成的标题",
      "summary": "只描述中国市场方向的完整句子",
      "overview": {
        "tone": "positive | negative | mixed",
        "interpretation": "只评估 CN 行情的影响和传导机制",
        "positive": ["0–4 个中国市场受益对象"],
        "negative": ["0–4 个中国市场承压对象"]
      }
    },
    "US": {
      "headline": "只依据 region=US 行情生成的标题",
      "summary": "只描述美国市场方向的完整句子",
      "overview": {
        "tone": "positive | negative | mixed",
        "interpretation": "只评估 US 行情的影响和传导机制",
        "positive": ["0–4 个美国市场受益对象"],
        "negative": ["0–4 个美国市场承压对象"]
      }
    }
  },
  "stories": [
    {
      "sourceIndex": 0,
      "category": "公司 | 宏观 | 商品 | 行业",
      "importance": 1,
      "title": "8–28 个汉字的自然中文标题",
      "summary": "15–90 个汉字，只陈述该条已核验 facts 明确表达的事件。",
      "tone": "positive | negative | mixed | neutral",
      "interpretation": "18–130 个汉字，写清事件→利润/成本/利率/估值/现金流/供需/风险偏好→板块或个股的传导链。",
      "sectors": ["1–3 个中文短标签"],
      "tickers": ["仅填写原始标题或 facts 可验证归属的 0–4 个代码"],
      "signal": {
        "thesis": "20–140 字：先写相对基准真正改变了什么，再写市场最应重视的变量。",
        "scoreReason": "12–100 字：说明该事件为何比同批候选更重要，不复述标题。",
        "transmission": [
          {
            "order": 1,
            "from": "必须能在该条标题或 facts 中找到依据的具体事件起点",
            "to": "具体价格、供需、财务变量、行业或公司",
            "mechanism": "12–100 字的具体传导机制。",
            "conditional": false
          }
        ],
        "exposures": [
          {
            "name": "具体行业、资产或公司",
            "ticker": "facts 明确归属时必填，否则省略",
            "exchange": "ticker 存在时必填，如 SSE/SZSE/NYSE/NASDAQ",
            "direction": "positive | negative | mixed",
            "basis": "12–100 字：该对象为何直接或间接受影响。"
          }
        ],
        "horizon": "intraday | 1-5d | 1-4w",
        "confidence": "low | medium | high",
        "checkpoint": {
          "metric": "未来可从权威来源核验的具体指标或事件",
          "dueInDays": 3,
          "confirmIf": "12–120 字：什么结果支持当前判断。",
          "invalidateIf": "12–120 字：什么结果推翻当前判断。"
        }
      }
    }
  ],
  "translations": {
    "en": {
      "headline": "English headline",
      "summary": "English summary.",
      "overview": {
        "interpretation": "English market impact interpretation.",
        "positive": ["Translated labels"],
        "negative": ["Translated labels"]
      },
      "marketViews": {
        "CN": {
          "headline": "English CN-market headline",
          "summary": "English CN-market summary.",
          "overview": {
            "interpretation": "English CN-market interpretation.",
            "positive": ["Translated labels"],
            "negative": ["Translated labels"]
          }
        },
        "US": {
          "headline": "English US-market headline",
          "summary": "English US-market summary.",
          "overview": {
            "interpretation": "English US-market interpretation.",
            "positive": ["Translated labels"],
            "negative": ["Translated labels"]
          }
        }
      },
      "stories": [
        {
          "title": "English title",
          "summary": "English summary.",
          "interpretation": "English interpretation.",
          "sectors": ["Translated sector labels"],
          "signal": {
            "thesis": "Translated thesis.",
            "scoreReason": "Translated selection reason.",
            "transmission": [
              {
                "from": "Translated factual starting point",
                "to": "Translated affected variable or object",
                "mechanism": "Translated mechanism."
              }
            ],
            "exposures": [
              {
                "name": "Translated exposure name",
                "basis": "Translated attribution basis."
              }
            ],
            "checkpoint": {
              "metric": "Translated checkpoint metric",
              "confirmIf": "Translated confirmation condition.",
              "invalidateIf": "Translated invalidation condition."
            }
          }
        }
      ]
    }
  }
}
```

`stories` 必须与 `daily-input.json.news` 等长且顺序一致，`sourceIndex` 从 `0` 连续递增。`importance >= 3` 时必须生成 `signal`；`importance < 3` 时必须省略 `signal`，页面不会展示这类低信号内容。

## 事实与质量边界

- 顶部 `headline`、`summary`、`overview` 只读取六项 `markets`，作为归档摘要；不得猜测涨跌原因，不得使用“领涨”“领跌”。
- `marketViews.CN` 只读取 `region=CN` 的两项指数，禁止出现美股、美债或美联储；`marketViews.US` 只读取 `region=US` 的四项指标，禁止出现 A 股、上证或沪深指数。每个分市场总览都必须独立判断利好、利空或分化。
- `overview.tone` 必须给出净利好、净利空或分化判断；`interpretation` 写清价格方向如何传导至估值、风险偏好、融资成本、需求或现金流，并列出主要受益与承压对象。
- 顶部只写方向和主要约束，不重复行情卡片已有的日期、点位、百分比、收益率或基点数字。
- 每条新闻只读取自己对应的原始标题、`facts`、来源和发布时间；先核对事实是否自洽，再判断净方向，不得把其他新闻或行情混入该条解读。
- `daily-input.json.news[].regions` 是采集与审计确定的市场归属，Agent 不得改写；页面据此在 CN/US 标签页过滤新闻。
- 工作日 `news` 每个市场必须有 4–6 条，周末必须有 3–6 条，采集目标为每边 5 条。个人理财、荐股、分析师观点、日历、汇总稿、人事变动和低相关性内容不能用于补足数量；若高质量候选仍低于下限，整次任务失败。
- `daily-input.json.newsDiagnostics` 只用于本地质量门，记录候选数、正文提取结果、分市场数量和各来源健康状态；它不写入 D1。单一来源失败时其余来源继续运行，最终仍必须满足数量与质量下限。
- `daily-input.json.updateKind` 为 `morning`、`close` 或 `evening`；对应北京时间
  `09:00`、`15:00` 与 `21:00` 截点。六项指数 / 收益率由
  `stock-analysis-api/scripts/market_data_query.py daily-pack` 通过 Skill contract
  一次性获取；该命令无需 FastAPI 常驻、固定 `persistence=none`，并在 API 内
  比较 FRED / Yahoo 与中国指数 fallback。`marketDataDiagnostics` 必须证明
  contract 完整、六项成功且无持久化；指数与行业日期不一致时整次拒绝发布。
  D1 只保存更新类型及 CN/US 各一个行情交易日，不保存本地 diagnostics 或逐项日期。
- `positive` 表示主要受影响资产净利好，`negative` 表示净利空，同时存在重要受益与承压对象时用 `mixed`。只有例行事项不改变定价、状态整体稳定或正负因素实质抵消时才用 `neutral`，并必须在解读中明确写出“中性”及其依据。
- `signal.thesis` 不得只是把 `interpretation` 换一种说法。先指出相对预期、前值、指引、既有政策或市场定价真正变化的部分；输入没有可靠基准时明确聚焦“新增事实”，不要编造市场共识。
- `signal.transmission` 必须从该条已核验事实中的具体名词开始，按 1–3 步写到财务变量、市场变量和受影响对象；不得以“消息、事件、相关板块、市场”等泛称同时充当起点与终点。
- `signal.exposures` 中出现 ticker 时必须同时给出交易所；标题或 facts 明确出现的上市公司必须列入，未明确出现的公司不得补入。
- `signal.horizon` 与 `checkpoint.dueInDays` 必须匹配：`intraday=0`、`1-5d=1–5`、`1-4w=6–28`。确认条件和推翻条件都必须可以在到期后客观核验，不得写“持续关注”“视情况而定”。
- `confidence` 只使用低、中、高三档，不生成百分比或伪精确概率。
- 禁止用“标题未披露”“信息不足”“无法判断”“方向未明”“取决于后续”代替分析。若 `facts` 仍不足以完成传导判断，质量门必须失败，不能生成日报。
- 指数新闻必须说明估值、风险偏好或指数权重机制；利率新闻必须说明折现率、融资成本、债券吸引力、无风险利率或估值机制。
- 价格涨跌不能倒置为利润变化的原因。禁止“相关股票可能上涨”“值得关注”“投资机会”等空泛模板或买卖建议。
- 不得新增该条原始标题与 `facts` 没有的数字、公司或已发生事实。条件情景必须保留“若”“如果”等条件措辞。
- 原始标题或 `facts` 明确出现 Apple、Amazon、Google/Alphabet、Meta、Microsoft、Nvidia、Tesla、AliExpress/Alibaba、Crown Holdings 或 Verisign 时，必须填写对应 ticker；没有明确公司时保持空数组。
- `translations.en` 只能翻译已经通过事实校验的中文内容，不增加数字、公司、事件或判断。中文“亿”金额应改写为自然英文金额；需要换算时用英文单词拼写数值（如 “eight hundred sixty million yuan”），避免生硬的 “hundred million” 直译和新增阿拉伯数字。
- `daily-input.json.sectorHeat` 由采集器确定性生成，不属于 Agent 输出：CN 使用中证全指 11 个一级行业指数，US 使用 11 个 GICS Sector SPDR，每边只保留价格波动强度最高的 3 个板块。
- 热度为 `0–100` 的价格波动强度，涨跌方向单独存储；连续高热按实际交易日去重，周末重复引用同一收盘不会增加天数。Agent 不得改写或推断该数据。
- 只输出页面需要的内容；D1 仅保存原始标题、最小核验事实摘要、来源链接和最终解读，不保存文章全文、网页 HTML、推理过程、prompt、token 明细或抓取原始响应。

## 调度

- 频率：每天三个主时段各刷新一次；同一时段的无实质推进补偿重试会跳过。
- 目标时间：北京时间 `09:00` 早间版、`15:00` A 股收盘版、`21:00` 晚间版（`Asia/Shanghai`）。
- 唤醒方式：`~/Library/LaunchAgents/com.stock-daily.codex.plist` 使用纽约本地 `20:00/21:00/22:00`、`02:00/03:00/04:00`、`08:00/09:00/10:00` 三组触发覆盖冬夏令时及失败重试。脚本按北京时间窗口识别模式，并分别使用 `work/last-scheduled-morning-date`、`work/last-scheduled-close-date` 与 `work/last-scheduled-evening-date` 保证每个时段每天最多成功一次。
- 执行位置：本机项目主目录，不使用 worktree。
- Codex 运行参数：`gpt-5.6-sol`、`medium` 推理、`workspace-write`，并忽略与日报无关的用户插件配置。
- 运行前提：Mac 保持开机，Codex CLI 与 Wrangler 登录态有效且网络可用。
- 手工早间版：`npm run daily:run`。
- 手工收盘版：`npm run daily:close`。
- 手工晚间版：`npm run daily:evening`。
- 指定日期回补：`scripts/run-codex-daily.sh --force --date YYYY-MM-DD --update-kind morning|close|evening`。
