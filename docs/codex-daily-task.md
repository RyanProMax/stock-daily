# Stock Daily 本机盘面归因任务

日报只解释已经完成的 CN、US 交易时段，不再生成普通新闻列表。完整流程由
`scripts/run-codex-daily.sh` 执行：采集行情、完整一级行业表现和候选证据；Agent
选择最多三条盘面驱动；本地质量门验证交易窗口、市场隔离、行业方向和证据；随后
发布并回读生产接口。

## V9 输出契约

`work/daily-report.json` 只能包含以下结构：

```json
{
  "headline": "原因或行业 + 市场表现的中文标题",
  "summary": "一句盘面结论。",
  "marketViews": {
    "CN": {
      "headline": "CN 原因或行业 + 市场表现",
      "summary": "CN 盘面归因结论。",
      "driverStatus": "explained | partial | unattributed"
    },
    "US": {
      "headline": "US 原因或行业 + 市场表现",
      "summary": "US 盘面归因结论。",
      "driverStatus": "explained | partial | unattributed"
    }
  },
  "drivers": [
    {
      "market": "CN | US",
      "role": "primary | secondary",
      "direction": "positive | negative | mixed",
      "title": "具体事实驱动",
      "summary": "发生了什么。",
      "mechanism": "该事实如何传导到本地行业和大盘。",
      "sectorSymbols": ["同市场一级行业代码"],
      "evidenceIndexes": [0]
    }
  ],
  "translations": {
    "en": {
      "headline": "Causal English headline",
      "summary": "English market conclusion.",
      "marketViews": {
        "CN": { "headline": "CN causal headline", "summary": "CN conclusion." },
        "US": { "headline": "US causal headline", "summary": "US conclusion." }
      },
      "drivers": [
        { "title": "Translated driver", "summary": "Translated event.", "mechanism": "Translated mechanism." }
      ]
    }
  }
}
```

## 归因规则

- 每个市场独立判断，只展示零至三条驱动；有驱动时只能有一条 `primary`。
- `event` 必须发生在前一收盘至本次收盘之间。`market_wrap` 可在收盘后两小时内
  发布，但必须明确包含同交易日指数或行业表现。
- 每条驱动至少引用一项、最多三项证据，并且必须包含该市场的收盘归因稿。外部事件
  进入 CN 时，仍必须有本地收盘归因和方向一致的 CN 一级行业，纯美股或美债消息不能
  单独成为 CN 驱动。
- `sectorSymbols` 只能引用 `sectorPerformance` 中同市场行业。`positive` 至少对应一个
  上涨行业，`negative` 至少对应一个下跌行业；第一版只说明行业领涨或领跌，不声称
  计算了指数加权贡献。
- 没有可靠原因时保留零条驱动，`driverStatus` 使用 `unattributed`，摘要必须明确写
  “未发现单一消息主导”。禁止猜测或用无关新闻补位。
- 同一事实若一方面支撑盈利或风险资产、另一方面推高利率等形成显著反向约束，
  `driverStatus` 必须使用 `partial`。标题优先写可直接观察的行业或指数结构，不得把
  这种事实写成单一宏观主因。
- 标题必须是“具体原因或行业 + 市场表现”，例如“贵金属与通信走强，创业板领涨”。
  禁止“股指普涨”“指数分化”“风险偏好改善”等无原因标题。
- 只使用输入中的核验事实，不新增数字、公司、事件或因果。英文只翻译已经通过校验
  的中文内容。
- `newsDiagnostics`、提供商、模型、契约或流水线术语只用于本地质量门，不进入读者页面。

## 发布完成条件

质量门通过不等于发布完成。定时任务只有在远程写入后回读生产接口，确认报告日期、
更新类型、CN/US 行情日期和驱动内容一致，才算完成。
