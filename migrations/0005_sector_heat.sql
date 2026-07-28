UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"name":"半导体","nameEn":"Semiconductors","score":90},{"name":"AI 服务器","nameEn":"AI Servers","score":84},{"name":"芯片设备","nameEn":"Chip Equipment","score":76},{"name":"科技股","nameEn":"Technology","score":68}]')
)
WHERE report_date = '2026-07-20';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"name":"质量成长","nameEn":"Quality Growth","score":88},{"name":"大盘龙头","nameEn":"Large-cap Leaders","score":84},{"name":"软件服务","nameEn":"Software Services","score":79},{"name":"高股息","nameEn":"High Dividend","score":68}]')
)
WHERE report_date = '2026-07-21';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"name":"大型科技","nameEn":"Mega-cap Tech","score":86},{"name":"能源","nameEn":"Energy","score":82},{"name":"成长股","nameEn":"Growth Stocks","score":78},{"name":"高现金流资产","nameEn":"High Cash-flow Assets","score":68}]')
)
WHERE report_date = '2026-07-22';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"name":"能源","nameEn":"Energy","score":94},{"name":"成长股","nameEn":"Growth Stocks","score":91},{"name":"AI 硬件","nameEn":"AI Hardware","score":87},{"name":"AI 服务器","nameEn":"AI Servers","score":82}]')
)
WHERE report_date = '2026-07-23';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"name":"原油","nameEn":"Crude Oil","score":90},{"name":"科技股","nameEn":"Technology","score":85},{"name":"食品","nameEn":"Food","score":78},{"name":"人工智能","nameEn":"Artificial Intelligence","score":70}]')
)
WHERE report_date = '2026-07-24';

UPDATE daily_reports
SET content = json_set(
  content,
  '$.sectorHeat',
  json('[{"name":"科技股","nameEn":"Technology","score":86},{"name":"能源","nameEn":"Energy","score":83},{"name":"食品消费","nameEn":"Food & Consumer","score":78},{"name":"人工智能","nameEn":"Artificial Intelligence","score":72}]')
)
WHERE report_date = '2026-07-25';
