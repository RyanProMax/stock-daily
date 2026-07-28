UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"market":"CN","symbol":"932085","name":"通信服务","nameEn":"Communication Services","score":100,"change":"-8.09%","direction":"down","asOf":"2026-07-17","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932085"},{"market":"CN","symbol":"932084","name":"信息技术","nameEn":"Information Technology","score":100,"change":"-7.72%","direction":"down","asOf":"2026-07-17","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932084"},{"market":"CN","symbol":"932082","name":"医药卫生","nameEn":"Health Care","score":100,"change":"-5.74%","direction":"down","asOf":"2026-07-17","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932082"},{"market":"US","symbol":"XLC","name":"通信服务","nameEn":"Communication Services","score":59,"change":"-1.78%","direction":"down","asOf":"2026-07-17","source":"https://www.nasdaq.com/market-activity/etf/xlc/historical"},{"market":"US","symbol":"XLY","name":"非必需消费品","nameEn":"Consumer Discretionary","score":54,"change":"-1.62%","direction":"down","asOf":"2026-07-17","source":"https://www.nasdaq.com/market-activity/etf/xly/historical"},{"market":"US","symbol":"XLE","name":"能源","nameEn":"Energy","score":39,"change":"+1.16%","direction":"up","asOf":"2026-07-17","source":"https://www.nasdaq.com/market-activity/etf/xle/historical"}]')
)
WHERE report_date = '2026-07-20';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"market":"CN","symbol":"932077","name":"能源","nameEn":"Energy","score":100,"change":"+5.54%","direction":"up","asOf":"2026-07-20","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932077"},{"market":"CN","symbol":"932086","name":"公用事业","nameEn":"Utilities","score":77,"change":"+3.85%","direction":"up","asOf":"2026-07-20","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932086"},{"market":"CN","symbol":"932084","name":"信息技术","nameEn":"Information Technology","score":76,"change":"-3.78%","direction":"down","asOf":"2026-07-20","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932084"},{"market":"US","symbol":"XLV","name":"医疗保健","nameEn":"Health Care","score":38,"change":"-1.14%","direction":"down","asOf":"2026-07-20","source":"https://www.nasdaq.com/market-activity/etf/xlv/historical"},{"market":"US","symbol":"XLB","name":"原材料","nameEn":"Materials","score":33,"change":"-0.99%","direction":"down","asOf":"2026-07-20","source":"https://www.nasdaq.com/market-activity/etf/xlb/historical"},{"market":"US","symbol":"XLI","name":"工业","nameEn":"Industrials","score":24,"change":"-0.72%","direction":"down","asOf":"2026-07-20","source":"https://www.nasdaq.com/market-activity/etf/xli/historical"}]')
)
WHERE report_date = '2026-07-21';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"market":"CN","symbol":"932084","name":"信息技术","nameEn":"Information Technology","score":100,"change":"+9.00%","direction":"up","asOf":"2026-07-21","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932084"},{"market":"CN","symbol":"932085","name":"通信服务","nameEn":"Communication Services","score":100,"change":"+5.50%","direction":"up","asOf":"2026-07-21","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932085"},{"market":"CN","symbol":"932078","name":"原材料","nameEn":"Materials","score":67,"change":"+3.35%","direction":"up","asOf":"2026-07-21","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932078"},{"market":"US","symbol":"XLK","name":"信息技术","nameEn":"Information Technology","score":96,"change":"+2.89%","direction":"up","asOf":"2026-07-21","source":"https://www.nasdaq.com/market-activity/etf/xlk/historical"},{"market":"US","symbol":"XLE","name":"能源","nameEn":"Energy","score":32,"change":"+0.97%","direction":"up","asOf":"2026-07-21","source":"https://www.nasdaq.com/market-activity/etf/xle/historical"},{"market":"US","symbol":"XLP","name":"必需消费品","nameEn":"Consumer Staples","score":31,"change":"-0.94%","direction":"down","asOf":"2026-07-21","source":"https://www.nasdaq.com/market-activity/etf/xlp/historical"}]')
)
WHERE report_date = '2026-07-22';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"market":"CN","symbol":"932085","name":"通信服务","nameEn":"Communication Services","score":59,"change":"-2.97%","direction":"down","asOf":"2026-07-22","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932085"},{"market":"CN","symbol":"932077","name":"能源","nameEn":"Energy","score":49,"change":"+2.43%","direction":"up","asOf":"2026-07-22","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932077"},{"market":"CN","symbol":"932084","name":"信息技术","nameEn":"Information Technology","score":34,"change":"-1.68%","direction":"down","asOf":"2026-07-22","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932084"},{"market":"US","symbol":"XLU","name":"公用事业","nameEn":"Utilities","score":75,"change":"+2.25%","direction":"up","asOf":"2026-07-22","source":"https://www.nasdaq.com/market-activity/etf/xlu/historical"},{"market":"US","symbol":"XLB","name":"原材料","nameEn":"Materials","score":48,"change":"+1.44%","direction":"up","asOf":"2026-07-22","source":"https://www.nasdaq.com/market-activity/etf/xlb/historical"},{"market":"US","symbol":"XLE","name":"能源","nameEn":"Energy","score":40,"change":"+1.20%","direction":"up","asOf":"2026-07-22","source":"https://www.nasdaq.com/market-activity/etf/xle/historical"}]')
)
WHERE report_date = '2026-07-23';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"market":"CN","symbol":"932078","name":"原材料","nameEn":"Materials","score":52,"change":"+2.61%","direction":"up","asOf":"2026-07-23","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932078"},{"market":"CN","symbol":"932079","name":"工业","nameEn":"Industrials","score":46,"change":"+2.29%","direction":"up","asOf":"2026-07-23","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932079"},{"market":"CN","symbol":"932084","name":"信息技术","nameEn":"Information Technology","score":45,"change":"-2.27%","direction":"down","asOf":"2026-07-23","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932084"},{"market":"US","symbol":"XLY","name":"非必需消费品","nameEn":"Consumer Discretionary","score":100,"change":"-4.61%","direction":"down","asOf":"2026-07-23","source":"https://www.nasdaq.com/market-activity/etf/xly/historical"},{"market":"US","symbol":"XLC","name":"通信服务","nameEn":"Communication Services","score":100,"change":"-3.50%","direction":"down","asOf":"2026-07-23","source":"https://www.nasdaq.com/market-activity/etf/xlc/historical"},{"market":"US","symbol":"XLI","name":"工业","nameEn":"Industrials","score":58,"change":"+1.73%","direction":"up","asOf":"2026-07-23","source":"https://www.nasdaq.com/market-activity/etf/xli/historical"}]')
)
WHERE report_date = '2026-07-24';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"market":"CN","symbol":"932078","name":"原材料","nameEn":"Materials","score":77,"change":"-3.86%","direction":"down","asOf":"2026-07-24","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932078"},{"market":"CN","symbol":"932086","name":"公用事业","nameEn":"Utilities","score":75,"change":"-3.77%","direction":"down","asOf":"2026-07-24","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932086"},{"market":"CN","symbol":"932082","name":"医药卫生","nameEn":"Health Care","score":72,"change":"-3.60%","direction":"down","asOf":"2026-07-24","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932082"},{"market":"US","symbol":"XLRE","name":"房地产","nameEn":"Real Estate","score":74,"change":"+2.22%","direction":"up","asOf":"2026-07-24","source":"https://www.nasdaq.com/market-activity/etf/xlre/historical"},{"market":"US","symbol":"XLB","name":"原材料","nameEn":"Materials","score":64,"change":"+1.93%","direction":"up","asOf":"2026-07-24","source":"https://www.nasdaq.com/market-activity/etf/xlb/historical"},{"market":"US","symbol":"XLK","name":"信息技术","nameEn":"Information Technology","score":48,"change":"-1.44%","direction":"down","asOf":"2026-07-24","source":"https://www.nasdaq.com/market-activity/etf/xlk/historical"}]')
)
WHERE report_date = '2026-07-25';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"market":"CN","symbol":"932078","name":"原材料","nameEn":"Materials","score":77,"change":"-3.86%","direction":"down","asOf":"2026-07-24","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932078"},{"market":"CN","symbol":"932086","name":"公用事业","nameEn":"Utilities","score":75,"change":"-3.77%","direction":"down","asOf":"2026-07-24","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932086"},{"market":"CN","symbol":"932082","name":"医药卫生","nameEn":"Health Care","score":72,"change":"-3.60%","direction":"down","asOf":"2026-07-24","source":"https://www.csindex.com.cn/#/indices/family/detail?indexCode=932082"},{"market":"US","symbol":"XLRE","name":"房地产","nameEn":"Real Estate","score":74,"change":"+2.22%","direction":"up","asOf":"2026-07-24","source":"https://www.nasdaq.com/market-activity/etf/xlre/historical"},{"market":"US","symbol":"XLB","name":"原材料","nameEn":"Materials","score":64,"change":"+1.93%","direction":"up","asOf":"2026-07-24","source":"https://www.nasdaq.com/market-activity/etf/xlb/historical"},{"market":"US","symbol":"XLK","name":"信息技术","nameEn":"Information Technology","score":48,"change":"-1.44%","direction":"down","asOf":"2026-07-24","source":"https://www.nasdaq.com/market-activity/etf/xlk/historical"}]')
)
WHERE report_date = '2026-07-26';
