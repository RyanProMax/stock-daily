# Stock Daily 本机 Codex 周报任务

每周日北京时间 `20:30`，本机 `launchd` 唤醒 `scripts/run-codex-weekly.sh`。确定性脚本从 D1 读取周一至周日的日报，并从官方日历采集下一周事件；Codex 只负责汇总、情景推演和双语表达。

## 输出契约

`work/weekly-report.json` 只包含：

```json
{
  "headline": "8–26 个汉字",
  "summary": "24–100 个汉字的完整句子",
  "overview": {
    "tone": "positive | negative | mixed",
    "interpretation": "36–190 个汉字，给出全周市场影响判断",
    "positive": ["1–4 个受益对象，净利空时可为空"],
    "negative": ["1–4 个承压对象，净利好时可为空"]
  },
  "highlights": ["3–5 条一周脉络，每条 20–120 字"],
  "outlook": {
    "base": "下周基准情景",
    "upside": "上行情景及触发条件",
    "downside": "下行情景及触发条件"
  },
  "events": [
    {
      "sourceIndex": 0,
      "title": "中文事件名",
      "whyItMatters": "说明影响渠道"
    }
  ],
  "translations": {
    "en": {
      "headline": "English headline",
      "summary": "English summary.",
      "overview": {
        "interpretation": "English interpretation.",
        "positive": ["Translated labels"],
        "negative": ["Translated labels"]
      },
      "highlights": ["Translated highlights"],
      "outlook": {
        "base": "Base case.",
        "upside": "Upside case.",
        "downside": "Downside case."
      },
      "events": [
        {
          "title": "English event title",
          "whyItMatters": "English impact channel."
        }
      ]
    }
  }
}
```

## 质量边界

- 只使用输入中的日报与官方事件候选，不补编行情、公司、数字或事件日期。
- 复盘应提炼跨日变化，不逐日复述。
- 推演必须写成带条件的基准、上行和下行情景，不写确定性预测。
- 事件只能引用 `upcomingEvents`，`sourceIndex` 必须有效；没有达到重要性门槛的事件可以不选。
- 不给出买卖、仓位、目标价或个性化投资建议。
- 英文内容只翻译已验证的中文结论。

## 调度

- 目标时间：每周日北京时间 `20:30`。
- LaunchAgent：`~/Library/LaunchAgents/com.stock-daily.codex-weekly.plist`。
- 手工试跑：`npm run weekly:run`。
- 指定周日：`scripts/run-codex-weekly.sh --force --week-end YYYY-MM-DD`。
