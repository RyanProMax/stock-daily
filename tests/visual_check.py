import json
import os
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("STOCK_DAILY_URL", "http://127.0.0.1:8788")
CHROME_PATH = os.environ.get(
    "CHROME_PATH",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
ENGINE = os.environ.get("BROWSER_ENGINE", "chromium")
RUN_TOKEN = str(time.time_ns())
SCREENSHOT_DIR = Path("artifacts/screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


def inspect_page(page, prefix, path, market, expected_market_count):
    is_mobile = page.viewport_size["width"] <= 760
    errors = []
    http_errors = []
    page.on(
        "console",
        lambda message: errors.append(
            {"text": message.text, "location": message.location}
        )
        if message.type == "error"
        else None,
    )
    page.on(
        "response",
        lambda response: http_errors.append(
            {"status": response.status, "url": response.url}
        )
        if response.status >= 400
        else None,
    )
    page.goto(f"{BASE_URL.rstrip('/')}{path}", wait_until="networkidle")
    page.evaluate("document.fonts.ready")
    page.add_style_tag(content="html { scroll-behavior: auto !important; }")
    page.wait_for_selector(".date-select-trigger")
    page.wait_for_timeout(600)
    page.locator(".snapshot-sector-disclosure").evaluate_all(
        "(elements) => elements.forEach((element) => { element.open = true; })"
    )
    page.locator(".hotspot-story").evaluate_all(
        "(elements) => elements.forEach((element) => { element.open = true; })"
    )
    page.locator(".signal-secondary-details").evaluate_all(
        "(elements) => elements.forEach((element) => { element.open = true; })"
    )
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(200)

    controls = page.locator(".date-arrow, .date-select-trigger")
    control_heights = [
        round(controls.nth(index).bounding_box()["height"], 2)
        for index in range(controls.count())
    ]
    header_controls = page.locator(".header-actions .control-button:visible")
    header_control_heights = [
        round(header_controls.nth(index).bounding_box()["height"], 2)
        for index in range(header_controls.count())
    ]
    market_switcher_height = round(
        page.locator(".market-switcher").bounding_box()["height"], 2
    )
    select_style = page.locator(".date-select-trigger").evaluate(
        """element => {
          const style = getComputedStyle(element);
          return {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight
          };
        }"""
    )
    serif_style = page.locator(".hero h1").evaluate(
        "element => getComputedStyle(element).fontFamily"
    )
    layout = page.evaluate(
        """() => ({
          viewportWidth: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          fontsLoaded: document.fonts.status,
          reportToolbarCount: document.querySelectorAll(
            '.report-toolbar'
          ).length,
          heroDateCount: document.querySelectorAll(
            '.hero .hero-date-nav'
          ).length,
          heroHeight: Math.round(document.querySelector(
            '.hero'
          ).getBoundingClientRect().height),
          heroBorderTopWidth: getComputedStyle(
            document.querySelector('.hero')
          ).borderTopWidth,
          heroBorderBottomWidth: getComputedStyle(
            document.querySelector('.hero')
          ).borderBottomWidth,
          publishBorderTopWidth: getComputedStyle(
            document.querySelector('.hero .publish-row')
          ).borderTopWidth,
          marketStatusHeight: Math.round(document.querySelector(
            '.market-snapshot'
          ).getBoundingClientRect().height),
          marketCount: document.querySelectorAll('.snapshot-item-index').length,
          indexColumnCount: getComputedStyle(document.querySelector(
            '.snapshot-index-grid'
          )).gridTemplateColumns.split(' ').length,
          marketValueOverlapCount: [...document.querySelectorAll(
            '.snapshot-item-index'
          )].filter(element => {
            const value = element.querySelector('strong');
            const change = element.querySelector('em');
            if (!value || !change) return false;
            const valueBox = value.getBoundingClientRect();
            const changeBox = change.getBoundingClientRect();
            return valueBox.left < changeBox.right &&
              valueBox.right > changeBox.left &&
              valueBox.top < changeBox.bottom &&
              valueBox.bottom > changeBox.top;
          }).length,
          heatCount: document.querySelectorAll('.snapshot-item-sector').length,
          visibleSectorCodeCount: [...document.querySelectorAll(
            '.snapshot-item-sector strong'
          )].filter(element => /^[A-Z0-9.^_-]{2,16}$/.test(
            element.textContent.trim()
          )).length,
          heatUpColors: [...document.querySelectorAll(
            '.snapshot-item-sector.snapshot-item-up .snapshot-item-top em'
          )].map(element => getComputedStyle(element).color),
          heatDownColors: [...document.querySelectorAll(
            '.snapshot-item-sector.snapshot-item-down .snapshot-item-top em'
          )].map(element => getComputedStyle(element).color),
          heatUpBackgrounds: [...document.querySelectorAll(
            '.snapshot-item-sector.snapshot-item-up'
          )].map(element => getComputedStyle(element).backgroundColor),
          heatDownBackgrounds: [...document.querySelectorAll(
            '.snapshot-item-sector.snapshot-item-down'
          )].map(element => getComputedStyle(element).backgroundColor),
          heatItemHeights: [...document.querySelectorAll(
            '.snapshot-item-sector'
          )].map(element => Math.round(element.getBoundingClientRect().height)),
          marketNames: [...document.querySelectorAll(
            '.snapshot-item-index .snapshot-item-top a, ' +
            '.snapshot-item-index .snapshot-item-top span'
          )].map(element => element.textContent.trim()),
          favorableColors: [...document.querySelectorAll(
            '.focus-impact-positive i'
          )].map(element => getComputedStyle(element).color),
          adverseColors: [...document.querySelectorAll(
            '.focus-impact-negative i'
          )].map(element => getComputedStyle(element).color),
          signalWindowLabels: [...document.querySelectorAll(
            '.signal-window'
          )].map(element => element.textContent.trim()),
          confidenceLabelCount: [...document.querySelectorAll(
            '.hotspot-title i'
          )].filter(element => /置信度|Confidence/.test(
            element.textContent
          )).length,
          storyCount: document.querySelectorAll('.hotspot-story').length,
          hotspotCount: document.querySelectorAll('.hotspot-group li').length,
          hotspotGroupCount: document.querySelectorAll('.hotspot-group').length,
          hotspotOverflowCount: [...document.querySelectorAll(
            '.hotspot-story > summary, .hotspot-source, .hotspot-analysis'
          )].filter(element => element.scrollWidth > element.clientWidth + 1)
            .length,
          expandedStoryCount: document.querySelectorAll(
            '.hotspot-story[open]'
          ).length,
          clippedExpandedContent: [...document.querySelectorAll(
            '.hotspot-story[open] .hotspot-analysis *'
          )].filter(element => {
            const style = getComputedStyle(element);
            const clippedX = ['hidden', 'clip'].includes(style.overflowX) &&
              element.scrollWidth > element.clientWidth + 1;
            const clippedY = ['hidden', 'clip'].includes(style.overflowY) &&
              element.scrollHeight > element.clientHeight + 1;
            return clippedX || clippedY;
          }).map(element => element.textContent.trim().slice(0, 80)),
          analysisHorizontalOverflow: [...document.querySelectorAll(
            '.hotspot-story[open] .hotspot-analysis'
          )].filter(element => element.scrollWidth > element.clientWidth + 1)
            .length,
          separateLedgerCount: document.querySelectorAll(
            '.thesis-ledger'
          ).length,
          todayFocusCount: [...document.querySelectorAll('.focus-kicker')]
            .filter(element => /今日重点|Today's Focus/.test(
              element.textContent
            )).length,
          nextCheckpointCount: document.querySelectorAll(
            '.focus-checkpoint'
          ).length,
          keySignalHeadingCount: document.querySelectorAll(
            '.signals-section > .daily-section-heading'
          ).length,
          whyImportantCount: document.querySelectorAll(
            '.signal-rationale'
          ).length,
          secondarySignalDetailCount: document.querySelectorAll(
            '.signal-secondary-details[open]'
          ).length,
          sectorDisclosureCount: document.querySelectorAll(
            '.snapshot-sector-disclosure[open]'
          ).length,
          visibleForbiddenCopy: (
            document.querySelector('main')?.innerText.match(
              /API\\s*Skill|market_data_query|codex-daily|agentModel|信号分|Signal score/gi
            ) ?? []
          ),
          visibleRawTimestamps: (
            document.querySelector('main')?.innerText.match(
              /\\b\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z\\b/g
            ) ?? []
          ),
          visiblePendingVerificationCount: (
            document.querySelector('main')?.innerText.match(/待核验/g) ?? []
          ).length,
          archiveRowHeights: [...document.querySelectorAll(
            '.archive-list a'
          )].map(element => Math.round(element.getBoundingClientRect().height)),
          archiveTitleSizes: [...document.querySelectorAll(
            '.archive-list strong'
          )].map(element => Number.parseFloat(getComputedStyle(element).fontSize)),
          archiveHeadingSize: Number.parseFloat(getComputedStyle(
            document.querySelector('.archive-heading h2')
          ).fontSize),
          marketUpdateCount: document.querySelectorAll(
            '.market-freshness time'
          ).length,
          marketUpdateText: document.querySelector(
            '.market-freshness time'
          )?.textContent.trim(),
          marketAsOfCount: document.querySelectorAll(
            '.market-freshness [data-market-as-of]'
          ).length,
          marketAsOfText: document.querySelector(
            '.market-freshness [data-market-as-of]'
          )?.textContent.trim(),
          duplicateMarketDateCount: document.querySelectorAll(
            '.market-price-meta time'
          ).length,
          heroHeadline: document.querySelector('.hero h1')?.textContent.trim(),
          heroSummaryCount: document.querySelectorAll('.hero-summary').length,
          copyButtonCount: document.querySelectorAll('.copy-button').length,
          duplicateEditionCount: [...document.querySelectorAll(
            '.hero-title-row > span'
          )].filter(element => /第\\s*\\d+\\s*期/.test(element.textContent))
            .length,
          archiveTitles: [...document.querySelectorAll('.archive-list strong')]
            .map(element => element.textContent.trim()),
          archiveCounts: [...document.querySelectorAll('.archive-list i')]
            .map(element => element.textContent.trim()),
          archiveTones: [...document.querySelectorAll(
            '.archive-tag[class*="archive-tone-"]'
          )].map(element => element.textContent.trim()),
          archiveTrends: [...document.querySelectorAll(
            '.archive-tag[class*="archive-trend-"]'
          )].map(element => element.textContent.trim()),
          visibleArchiveTrendCount: [...document.querySelectorAll(
            '.archive-tag[class*="archive-trend-"]'
          )].filter(element => element.getClientRects().length > 0).length,
          activeMarket: document.querySelector(
            '.market-switcher a[aria-current="page"]'
          )?.textContent.trim(),
          legacyPendingCount: [...document.querySelectorAll('.impact-badge')]
            .filter(element => element.textContent.trim() === '待确认').length,
          legacyUnclearCount: [...document.querySelectorAll('.impact-badge')]
            .filter(element => element.textContent.trim() === '方向未明').length,
          neutralCount: [...document.querySelectorAll('.impact-badge')]
            .filter(element => element.textContent.trim() === '中性').length,
          hasSsrHtml: Boolean(document.querySelector('[data-render="ssr"]')),
          realizedEventCount: document.querySelectorAll(
            '[data-event-state="realized"]'
          ).length,
          pendingEventCount: document.querySelectorAll(
            '[data-event-state="awaiting"], [data-event-state="scheduled"]'
          ).length,
          eventImpactLabels: [...document.querySelectorAll(
            '[data-event-impact]'
          )].map(element => element.textContent.trim()),
          realizedStatusLabelCount: [...document.querySelectorAll(
            '.hotspot-event-meta span'
          )].filter(element => element.textContent.trim() === '已兑现').length,
          richEventResultCount: [...document.querySelectorAll(
            '[data-event-result] dl'
          )].filter(element => element.querySelectorAll(':scope > div').length >= 4)
            .length,
          eventGridHorizontalOverflow: [...document.querySelectorAll(
            '.hotspot-event-grid'
          )].filter(element => element.scrollWidth > element.clientWidth + 1)
            .length,
          pricingThesisCount: document.querySelectorAll(
            '.pricing-thesis'
          ).length,
          marketSectionHeadingCount: document.querySelectorAll(
            '.market-section > .section-intro'
          ).length,
          pricingBoardHeadingCount: document.querySelectorAll(
            '.pricing-board > .hotspot-board-heading'
          ).length,
          groupHeaderStyles: [...document.querySelectorAll(
            '.hotspot-events > header, .hotspot-group > header'
          )].map(element => {
            const style = getComputedStyle(element);
            return {
              backgroundColor: style.backgroundColor,
              borderLeftColor: style.borderLeftColor,
              borderLeftWidth: style.borderLeftWidth,
              color: style.color,
              height: Math.round(element.getBoundingClientRect().height)
            };
          }),
          eventHeaderAccent: (() => {
            const element = document.querySelector('.hotspot-events > header');
            return element ? getComputedStyle(element).borderLeftColor : null;
          })(),
          coreHeaderAccent: getComputedStyle(document.querySelector(
            '.hotspot-group-core > header'
          )).borderLeftColor,
          realizedEventShadows: [...document.querySelectorAll(
            '.hotspot-event-realized'
          )].map(element => getComputedStyle(element).boxShadow),
          pricingBoardStyle: (() => {
            const style = getComputedStyle(document.querySelector(
              '.pricing-board'
            ));
            return {
              borderRadius: style.borderRadius,
              boxShadow: style.boxShadow
            };
          })(),
          archiveHeadingText: document.querySelector(
            '.archive-heading h2'
          )?.textContent.trim(),
          wrappedShortLabels: [...document.querySelectorAll(
            '.impact-badge, .event-impact-tag, .event-status-tag, ' +
            '.hotspot-title i, .hotspot-impact i, ' +
            '.control-button, .market-switcher a, .section-intro h2 small, ' +
            '.archive-tag, .market-freshness time, .market-freshness span'
          )].filter(element => element.scrollHeight > element.clientHeight + 1)
            .map(element => element.textContent.trim())
        })"""
    )

    page.screenshot(path=str(SCREENSHOT_DIR / f"{prefix}-top.png"))
    event_or_board = page.locator(".hotspot-events, .hotspot-board").first
    event_or_board.scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    page.screenshot(path=str(SCREENSHOT_DIR / f"{prefix}-ai.png"))
    page.add_style_tag(
        content=(
            ".masthead { position: static !important; } "
            ".skip-link { display: none !important; }"
        )
    )
    first_expanded_story = page.locator(".hotspot-story[open]").first
    first_expanded_story.scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    page.screenshot(path=str(SCREENSHOT_DIR / f"{prefix}-signal.png"))
    first_expanded_story.screenshot(
        path=str(SCREENSHOT_DIR / f"{prefix}-first-expanded.png")
    )
    page.locator(".hotspot-board").first.screenshot(
        path=str(SCREENSHOT_DIR / f"{prefix}-board-expanded.png")
    )
    page.locator(".archive-section").scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    page.locator(".archive-section").screenshot(
        path=str(SCREENSHOT_DIR / f"{prefix}-archive.png")
    )
    page.screenshot(
        path=str(SCREENSHOT_DIR / f"{prefix}-full-expanded.png"),
        full_page=True,
        scale="css",
    )

    drawer = None
    if is_mobile:
        theme_before = page.locator("html").get_attribute("data-theme")
        page.locator(".mobile-menu-trigger").click()
        page.wait_for_selector(".mobile-drawer")
        page.wait_for_timeout(220)
        language_action = page.locator(".mobile-drawer-language")
        drawer = {
            "navigationCount": page.locator(".mobile-drawer-nav a").count(),
            "settingsCount": page.locator(".drawer-setting").count(),
            "languageHref": language_action.get_attribute("href"),
            "themeBefore": theme_before,
            "themeLabel": page.locator(
                ".mobile-drawer-theme strong"
            ).inner_text(),
        }
        page.screenshot(path=str(SCREENSHOT_DIR / f"{prefix}-drawer.png"))
        page.locator(".mobile-drawer-theme").click()
        page.wait_for_timeout(120)
        drawer["themeAfter"] = page.locator("html").get_attribute("data-theme")
        drawer["themeChanged"] = drawer["themeAfter"] != drawer["themeBefore"]
        page.locator(".drawer-close").click()
        page.wait_for_selector(".mobile-drawer-overlay", state="detached")
        drawer["closed"] = page.locator(".mobile-drawer-overlay").count() == 0
        page.locator(".mobile-menu-trigger").click()
        page.wait_for_selector(".mobile-drawer")
        page.locator(".mobile-drawer-language").click()
        page.wait_for_url("**lang=en**")
        page.wait_for_load_state("networkidle")
        drawer["languageAfter"] = page.locator("html").get_attribute("lang")
        drawer["languageChanged"] = drawer["languageAfter"] == "en"

    return {
        "controlHeights": control_heights,
        "headerControlHeights": header_control_heights,
        "marketSwitcherHeight": market_switcher_height,
        "market": market,
        "expectedMarketCount": expected_market_count,
        "selectStyle": select_style,
        "serifStyle": serif_style,
        "layout": layout,
        "consoleErrors": errors,
        "httpErrors": http_errors,
        "drawer": drawer,
    }


with sync_playwright() as playwright:
    if ENGINE == "webkit":
        browser = playwright.webkit.launch(headless=True)
    else:
        launch_options = {
            "headless": True,
            "args": ["--disable-dev-shm-usage"],
        }
        if CHROME_PATH:
            launch_options["executable_path"] = CHROME_PATH
        browser = playwright.chromium.launch(**launch_options)
    result = {}
    for market, count in (("CN", 6), ("US", 4)):
        mobile = browser.new_page(
            viewport={"width": 390, "height": 844},
            device_scale_factor=3,
            is_mobile=True,
            has_touch=True,
        )
        desktop = browser.new_page(
            viewport={"width": 1440, "height": 1000},
            device_scale_factor=1,
        )
        query = f"/?market={market.lower()}&visual={RUN_TOKEN}-{market.lower()}"
        result[f"mobile{market}"] = inspect_page(
            mobile,
            f"{ENGINE}-mobile-390-{market.lower()}",
            query,
            market,
            count,
        )
        result[f"desktop{market}"] = inspect_page(
            desktop,
            f"{ENGINE}-desktop-1440-{market.lower()}",
            query,
            market,
            count,
        )

    english = browser.new_page(viewport={"width": 1280, "height": 900})
    english.goto(
        f"{BASE_URL.rstrip('/')}?lang=en&market=us&visual={RUN_TOKEN}-en",
        wait_until="networkidle",
    )
    result["english"] = {
        "lang": english.locator("html").get_attribute("lang"),
        "hasOverview": english.get_by_text(
            "Bottom Line", exact=True
        ).count() > 0,
        "marketCount": english.locator(".snapshot-item-index").count(),
        "marketUpdate": english.locator(".market-freshness time").inner_text(),
        "marketAsOf": english.locator(
            ".market-freshness [data-market-as-of]"
        ).inner_text(),
        "activeMarket": english.locator(
            '.market-switcher a[aria-current="page"]'
        ).inner_text(),
        "archiveTones": english.locator(
            '.archive-tag[class*="archive-tone-"]'
        ).all_text_contents(),
        "archiveTrends": english.locator(
            '.archive-tag[class*="archive-trend-"]'
        ).all_text_contents(),
    }

    neutral = browser.new_page(
        viewport={"width": 390, "height": 844},
        device_scale_factor=3,
        is_mobile=True,
        has_touch=True,
    )
    neutral.goto(
        (
            f"{BASE_URL.rstrip('/')}"
            f"?date=2026-07-23&market=us&visual={RUN_TOKEN}-neutral"
        ),
        wait_until="networkidle",
    )
    neutral.evaluate("document.fonts.ready")
    neutral_badge = neutral.locator(".impact-badge").filter(has_text="中性")
    if neutral_badge.count() > 0:
        neutral_badge.first.scroll_into_view_if_needed()
        neutral.wait_for_timeout(250)
        neutral.screenshot(
            path=str(SCREENSHOT_DIR / f"{ENGINE}-mobile-390-neutral.png")
        )
    result["neutral"] = {
        "count": neutral_badge.count(),
        "legacyPendingCount": neutral.get_by_text("待确认", exact=True).count(),
        "legacyUnclearCount": neutral.get_by_text("方向未明", exact=True).count(),
        "wrapped": (
            neutral_badge.first.evaluate(
                "element => element.scrollHeight > element.clientHeight + 1"
            )
            if neutral_badge.count() > 0
            else False
        ),
    }

    weekly_errors = []
    weekly = browser.new_page(
        viewport={"width": 390, "height": 844},
        device_scale_factor=3,
        is_mobile=True,
        has_touch=True,
    )
    weekly.on(
        "console",
        lambda message: weekly_errors.append(message.text)
        if message.type == "error"
        else None,
    )
    weekly.goto(
        f"{BASE_URL.rstrip('/')}/weekly?visual={RUN_TOKEN}-weekly",
        wait_until="networkidle",
    )
    weekly.evaluate("document.fonts.ready")
    weekly.wait_for_timeout(600)
    weekly.screenshot(
        path=str(SCREENSHOT_DIR / f"{ENGINE}-mobile-390-weekly.png")
    )
    result["weekly"] = {
        "hasSsrHtml": weekly.locator('[data-render="ssr"]').count() == 1,
        "hasOutlook": weekly.get_by_text("下周推演", exact=True).count() == 1,
        "hasEvents": weekly.get_by_text("未来一周关键事件", exact=True).count()
        == 1,
        "hasEmpty": weekly.get_by_text(
            "首份周报将在周日晚上生成。", exact=True
        ).count()
        == 1,
        "scrollWidth": weekly.evaluate("document.documentElement.scrollWidth"),
        "consoleErrors": weekly_errors,
    }
    browser.close()

for key in ("mobileCN", "mobileUS", "desktopCN", "desktopUS"):
    audit = result[key]
    is_mobile = key.startswith("mobile")
    assert audit["controlHeights"] == (
        [30, 30, 30] if is_mobile else [36, 36, 36]
    ), result
    assert audit["headerControlHeights"] == (
        [42] if is_mobile else [46, 46]
    ), result
    assert audit["marketSwitcherHeight"] == (42 if is_mobile else 46), result
    assert "Noto Sans SC Variable" in audit["selectStyle"]["fontFamily"], result
    assert "Noto Serif SC Variable" in audit["serifStyle"], result
    assert audit["layout"]["scrollWidth"] <= (
        390 if is_mobile else 1440
    ), result
    assert audit["layout"]["reportToolbarCount"] == 0, result
    assert audit["layout"]["heroDateCount"] == 1, result
    assert audit["layout"]["heroHeight"] <= (520 if is_mobile else 360), result
    assert audit["layout"]["heroBorderTopWidth"] == "0px", result
    assert audit["layout"]["heroBorderBottomWidth"] == "1px", result
    assert audit["layout"]["publishBorderTopWidth"] == "0px", result
    assert audit["layout"]["marketStatusHeight"] <= (
        350 if is_mobile else 220
    ), result
    assert audit["layout"]["fontsLoaded"] == "loaded", result
    assert audit["layout"]["marketCount"] == audit["expectedMarketCount"], result
    assert audit["layout"]["indexColumnCount"] == (
        (3 if audit["market"] == "CN" else 2)
        if is_mobile
        else audit["expectedMarketCount"]
    ), result
    assert audit["layout"]["marketValueOverlapCount"] == 0, result
    assert audit["layout"]["heatCount"] == 6, result
    assert audit["layout"]["visibleSectorCodeCount"] == 0, result
    if (
        audit["layout"]["heatUpColors"]
        and audit["layout"]["heatDownColors"]
    ):
        assert set(audit["layout"]["heatUpColors"]).isdisjoint(
            audit["layout"]["heatDownColors"]
        ), result
        assert set(audit["layout"]["heatUpBackgrounds"]).isdisjoint(
            audit["layout"]["heatDownBackgrounds"]
        ), result
    assert all(
        height <= (62 if is_mobile else 58)
        for height in audit["layout"]["heatItemHeights"]
    ), result
    if audit["market"] == "US":
        assert any(
            "美国 10 年期国债收益率" in name
            for name in audit["layout"]["marketNames"]
        ), result
    assert set(audit["layout"]["favorableColors"]).isdisjoint(
        audit["layout"]["adverseColors"]
    ), result
    assert all(
        "影响周期" in label or "Pricing window" in label
        for label in audit["layout"]["signalWindowLabels"]
    ), result
    assert audit["layout"]["confidenceLabelCount"] == 0, result
    assert 1 <= audit["layout"]["storyCount"] <= 3, result
    assert audit["layout"]["expandedStoryCount"] == audit["layout"]["storyCount"], result
    assert audit["layout"]["hotspotOverflowCount"] == 0, result
    assert audit["layout"]["analysisHorizontalOverflow"] == 0, result
    assert audit["layout"]["clippedExpandedContent"] == [], result
    assert audit["layout"]["separateLedgerCount"] == 0, result
    assert audit["layout"]["todayFocusCount"] == 1, result
    assert audit["layout"]["nextCheckpointCount"] == 0, result
    assert audit["layout"]["keySignalHeadingCount"] == 0, result
    assert audit["layout"]["whyImportantCount"] == audit["layout"][
        "storyCount"
    ], result
    assert audit["layout"]["sectorDisclosureCount"] == 1, result
    assert audit["layout"]["visibleForbiddenCopy"] == [], result
    assert audit["layout"]["visibleRawTimestamps"] == [], result
    assert audit["layout"]["visiblePendingVerificationCount"] == 0, result
    assert all(
        height <= (54 if is_mobile else 60)
        for height in audit["layout"]["archiveRowHeights"]
    ), result
    assert all(
        size <= (13 if is_mobile else 14)
        for size in audit["layout"]["archiveTitleSizes"]
    ), result
    assert audit["layout"]["archiveHeadingSize"] <= (
        12 if is_mobile else 14
    ), result
    assert all(
        any(str(value) in count for value in range(3, 7))
        for count in audit["layout"]["archiveCounts"]
    ), result
    assert audit["layout"]["marketUpdateCount"] == 1, result
    assert audit["layout"]["marketUpdateText"].startswith("更新："), result
    assert audit["layout"]["marketAsOfCount"] == 1, result
    market_label = "A股" if audit["market"] == "CN" else "美股"
    assert audit["layout"]["marketAsOfText"].startswith(
        f"{market_label}数据截至"
    ), result
    assert any(
        qualifier in audit["layout"]["marketAsOfText"]
        for qualifier in ("今天", "昨天", "最近交易日")
    ), result
    assert audit["layout"]["marketAsOfText"].endswith("收盘"), result
    assert audit["layout"]["duplicateMarketDateCount"] == 0, result
    assert audit["layout"]["heroSummaryCount"] == 0, result
    assert audit["layout"]["copyButtonCount"] == 0, result
    assert audit["layout"]["duplicateEditionCount"] == 0, result
    assert len(audit["layout"]["archiveTones"]) == len(
        audit["layout"]["archiveTitles"]
    ), result
    assert len(audit["layout"]["archiveTrends"]) == len(
        audit["layout"]["archiveTitles"]
    ), result
    assert audit["layout"]["visibleArchiveTrendCount"] == len(
        audit["layout"]["archiveTitles"]
    ), result
    assert all(
        tone.startswith("整体") for tone in audit["layout"]["archiveTones"]
    ), result
    assert all(
        trend.startswith(("大盘上涨", "大盘下跌", "大盘分化", "大盘持平"))
        and "%" in trend
        for trend in audit["layout"]["archiveTrends"]
    ), result
    assert audit["layout"]["activeMarket"] == audit["market"], result
    assert audit["layout"]["legacyPendingCount"] == 0, result
    assert audit["layout"]["legacyUnclearCount"] == 0, result
    assert audit["layout"]["hasSsrHtml"], result
    assert audit["layout"]["realizedEventCount"] in (0, 3), result
    assert len(audit["layout"]["eventImpactLabels"]) == (
        audit["layout"]["realizedEventCount"]
    ), result
    assert set(audit["layout"]["eventImpactLabels"]).issubset(
        {"利好", "利空", "中性"}
    ), result
    assert audit["layout"]["realizedStatusLabelCount"] == 0, result
    assert audit["layout"]["richEventResultCount"] == audit["layout"][
        "realizedEventCount"
    ], result
    if is_mobile:
        assert audit["layout"]["eventGridHorizontalOverflow"] == 0, result
    assert audit["layout"]["pricingThesisCount"] == 0, result
    assert audit["layout"]["marketSectionHeadingCount"] == 0, result
    assert audit["layout"]["pricingBoardHeadingCount"] == 0, result
    group_headers = audit["layout"]["groupHeaderStyles"]
    assert len(group_headers) >= 1, result
    assert len({item["backgroundColor"] for item in group_headers}) == 1, result
    assert len({item["color"] for item in group_headers}) == 1, result
    assert all(item["borderLeftWidth"] == "0px" for item in group_headers), result
    assert len({item["borderLeftColor"] for item in group_headers}) >= 1, result
    assert len({item["height"] for item in group_headers}) == 1, result
    if audit["layout"]["eventHeaderAccent"] is not None:
        assert audit["layout"]["eventHeaderAccent"] == audit["layout"][
            "coreHeaderAccent"
        ], result
    assert set(audit["layout"]["realizedEventShadows"]) <= {"none"}, result
    assert audit["layout"]["pricingBoardStyle"] == {
        "borderRadius": "0px 0px 14px 14px",
        "boxShadow": "none",
    }, result
    assert audit["layout"]["archiveHeadingText"] == "往期日报", result
    assert audit["layout"]["wrappedShortLabels"] == [], result
    assert audit["consoleErrors"] == [], result
    assert audit["httpErrors"] == [], result
    if is_mobile:
        assert audit["drawer"]["navigationCount"] == 3, result
        assert audit["drawer"]["settingsCount"] == 2, result
        assert "lang=en" in audit["drawer"]["languageHref"], result
        assert audit["drawer"]["themeChanged"], result
        assert audit["drawer"]["closed"], result
        assert audit["drawer"]["languageChanged"], result
    else:
        assert audit["drawer"] is None, result

assert result["mobileCN"]["layout"]["activeMarket"] != result["mobileUS"]["layout"]["activeMarket"], result
assert result["mobileCN"]["layout"]["heroHeadline"] != result["mobileUS"]["layout"]["heroHeadline"], result
assert result["mobileCN"]["layout"]["archiveTitles"] != result["mobileUS"]["layout"]["archiveTitles"], result
assert result["english"]["lang"] == "en", result
assert result["english"]["hasOverview"], result
assert result["english"]["marketCount"] == 4, result
assert result["english"]["marketUpdate"].startswith("Updated "), result
assert result["english"]["marketAsOf"].startswith("U.S. data through "), result
assert result["english"]["marketAsOf"].endswith(")"), result
assert result["english"]["activeMarket"] == "US", result
assert all(
    tone.startswith("Overall ") for tone in result["english"]["archiveTones"]
), result
assert all(
    trend.startswith(("Indexes up", "Indexes down", "Indexes mixed", "Indexes flat"))
    and "%" in trend
    for trend in result["english"]["archiveTrends"]
), result
assert result["neutral"]["legacyPendingCount"] == 0, result
assert result["neutral"]["legacyUnclearCount"] == 0, result
assert result["neutral"]["wrapped"] is False, result
assert result["weekly"]["hasSsrHtml"], result
assert (
    result["weekly"]["hasOutlook"] and result["weekly"]["hasEvents"]
) or result["weekly"]["hasEmpty"], result
assert result["weekly"]["scrollWidth"] <= 390, result
assert result["weekly"]["consoleErrors"] == [], result

print(json.dumps(result, ensure_ascii=False, indent=2))
