import json
import os
import re
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("STOCK_DAILY_URL", "http://127.0.0.1:8788").rstrip("/")
CHROME_PATH = os.environ.get(
    "CHROME_PATH",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
RUN_TOKEN = str(time.time_ns())
SCREENSHOT_DIR = Path("artifacts/screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


def inspect_daily(page, market, width):
    mobile = width == 390
    console_errors = []
    http_errors = []
    page.on(
        "console",
        lambda message: console_errors.append(message.text)
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
    page.goto(
        f"{BASE_URL}/?market={market.lower()}&lang=zh&visual={RUN_TOKEN}-{market}-{width}",
        wait_until="networkidle",
    )
    page.evaluate("document.fonts.ready")
    page.wait_for_selector(".market-driver-card")
    page.add_style_tag(
        content=(
            "html { scroll-behavior: auto !important; } "
            ".masthead { position: static !important; } "
            ".skip-link { display: none !important; }"
        )
    )
    page.wait_for_timeout(250)

    layout = page.evaluate(
        """() => {
          const clipped = selector => [...document.querySelectorAll(selector)]
            .filter(element => {
              const style = getComputedStyle(element);
              const clippedX = ['hidden', 'clip'].includes(style.overflowX) &&
                element.scrollWidth > element.clientWidth + 1;
              const clippedY = ['hidden', 'clip'].includes(style.overflowY) &&
                element.scrollHeight > element.clientHeight + 1;
              return clippedX || clippedY;
            }).map(element => ({
              className: element.className,
              text: element.textContent.trim().slice(0, 80)
            }));
          const offCanvas = [...document.querySelectorAll(
            '.snapshot-item, .market-driver-card, .market-driver-card *'
          )].filter(element => {
            const box = element.getBoundingClientRect();
            return box.left < -1 || box.right > innerWidth + 1;
          }).map(element => ({
            className: element.className,
            left: Math.round(element.getBoundingClientRect().left),
            right: Math.round(element.getBoundingClientRect().right)
          }));
          const hero = document.querySelector('.hero');
          const market = document.querySelector('.market-section');
          const signals = document.querySelector('.signals-section');
          return {
            viewportWidth: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            fontsLoaded: document.fonts.status,
            hasSsrHtml: Boolean(document.querySelector('[data-render="ssr"]')),
            heroHeadline: document.querySelector('.hero h1')?.textContent.trim(),
            heroSummary: document.querySelector('.focus-summary')?.textContent.trim(),
            activeMarket: document.querySelector(
              '.market-switcher a[aria-current="page"]'
            )?.textContent.trim(),
            marketCount: document.querySelectorAll('.snapshot-item-index').length,
            sectorCount: document.querySelectorAll(
              '.snapshot-sector-grid-complete .snapshot-item-sector'
            ).length,
            sectorColumnCount: getComputedStyle(document.querySelector(
              '.snapshot-sector-grid-complete'
            )).gridTemplateColumns.split(' ').length,
            indexColumnCount: getComputedStyle(document.querySelector(
              '.snapshot-index-grid'
            )).gridTemplateColumns.split(' ').length,
            driverCount: document.querySelectorAll('.market-driver-card').length,
            primaryDriverCount: document.querySelectorAll(
              '.market-driver-role.role-primary'
            ).length,
            evidenceLinkCount: document.querySelectorAll(
              '.market-driver-evidence a'
            ).length,
            driverSectorChipCount: document.querySelectorAll(
              '.market-driver-sectors .sector-chip'
            ).length,
            driverCardWidths: [...document.querySelectorAll(
              '.market-driver-card'
            )].map(element => Math.round(element.getBoundingClientRect().width)),
            driverCardHeights: [...document.querySelectorAll(
              '.market-driver-card'
            )].map(element => Math.round(element.getBoundingClientRect().height)),
            sectorHeights: [...document.querySelectorAll(
              '.snapshot-sector-grid-complete .snapshot-item-sector'
            )].map(element => Math.round(element.getBoundingClientRect().height)),
            clippedContent: clipped(
              '.market-driver-card, .market-driver-card *, .snapshot-item-sector, .snapshot-item-sector *'
            ),
            offCanvas,
            archiveCount: document.querySelectorAll('.archive-section').length,
            dateNavigationCount: document.querySelectorAll('.hero-date-nav').length,
            legacyStoryCount: document.querySelectorAll('.hotspot-story').length,
            weeklyEventCount: document.querySelectorAll('.hotspot-events').length,
            thesisLedgerCount: document.querySelectorAll('.thesis-ledger').length,
            redundantHeadingCount: document.querySelectorAll(
              '.signals-section > .daily-section-heading'
            ).length,
            confidenceLabelCount: [...document.querySelectorAll('main *')]
              .filter(element => /置信度|Confidence/.test(element.textContent) &&
                element.children.length === 0).length,
            windowLabelCount: [...document.querySelectorAll('main *')]
              .filter(element => /1[–-]4周|Pricing window/.test(element.textContent) &&
                element.children.length === 0).length,
            pendingVerificationCount: (
              document.querySelector('main')?.innerText.match(/待核验/g) ?? []
            ).length,
            forbiddenCopy: (
              document.querySelector('main')?.innerText.match(
                /API\\s*Skill|market_data_query|codex-daily|agentModel|信号分|Signal score/gi
              ) ?? []
            ),
            rawTimestamps: (
              document.querySelector('main')?.innerText.match(
                /\\b\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z\\b/g
              ) ?? []
            ),
            coreDetailsCount: document.querySelectorAll(
              '.signals-section details'
            ).length,
            sectionsInOrder: Boolean(hero && market && signals &&
              hero.getBoundingClientRect().top < market.getBoundingClientRect().top &&
              market.getBoundingClientRect().top < signals.getBoundingClientRect().top),
            marketAsOf: document.querySelector(
              '.market-freshness [data-market-as-of]'
            )?.textContent.trim(),
            sourceLabels: [...document.querySelectorAll(
              '.market-driver-evidence a'
            )].map(element => element.textContent.trim()),
          };
        }"""
    )

    prefix = f"daily-v9-{'mobile-390' if mobile else 'desktop-1440'}-{market.lower()}"
    page.screenshot(
        path=str(SCREENSHOT_DIR / f"{prefix}-full.png"),
        full_page=True,
        scale="css",
    )
    page.locator(".market-snapshot").screenshot(
        path=str(SCREENSHOT_DIR / f"{prefix}-market.png")
    )
    page.locator(".market-driver-list").screenshot(
        path=str(SCREENSHOT_DIR / f"{prefix}-drivers.png")
    )

    drawer = None
    if mobile:
        page.locator(".mobile-menu-trigger").click()
        page.wait_for_selector(".mobile-drawer")
        drawer = {
            "navigationCount": page.locator(".mobile-drawer-nav a").count(),
            "hasArchiveAction": page.locator(
                '.mobile-drawer-nav a[href="#archive"]'
            ).count(),
        }
        page.screenshot(path=str(SCREENSHOT_DIR / f"{prefix}-drawer.png"))
        page.locator(".drawer-close").click()
        page.wait_for_selector(".mobile-drawer-overlay", state="detached")

    return {
        "layout": layout,
        "consoleErrors": console_errors,
        "httpErrors": http_errors,
        "drawer": drawer,
    }


with sync_playwright() as playwright:
    browser_args = ["--disable-dev-shm-usage"]
    if "localtest.me" in BASE_URL or "127.0.0.1" in BASE_URL:
        browser_args.append("--no-proxy-server")
    launch_options = {
        "headless": True,
        "args": browser_args,
    }
    if CHROME_PATH:
        launch_options["executable_path"] = CHROME_PATH
    browser = playwright.chromium.launch(**launch_options)
    result = {}
    for market in ("CN", "US"):
        for width, height in ((1440, 1000), (390, 844)):
            page = browser.new_page(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
                is_mobile=width == 390,
                has_touch=width == 390,
            )
            result[f"{market}-{width}"] = inspect_daily(page, market, width)
            page.close()

    english = browser.new_page(viewport={"width": 1280, "height": 900})
    english.goto(
        f"{BASE_URL}/?lang=en&market=us&visual={RUN_TOKEN}-english",
        wait_until="networkidle",
    )
    result["english"] = {
        "lang": english.locator("html").get_attribute("lang"),
        "driverCount": english.locator(".market-driver-card").count(),
        "hasEventLabel": english.get_by_text("What happened", exact=True).count(),
        "hasMechanismLabel": english.get_by_text(
            "Market transmission", exact=True
        ).count(),
        "hasGenericHeadline": bool(
            re.search(
                r"indexes? (rise|fall)|risk appetite|market divergence",
                english.locator(".hero h1").inner_text(),
                re.IGNORECASE,
            )
        ),
    }
    browser.close()


for key in ("CN-1440", "US-1440", "CN-390", "US-390"):
    audit = result[key]
    layout = audit["layout"]
    market, width = key.split("-")
    mobile = width == "390"
    assert layout["scrollWidth"] <= int(width), result
    assert layout["fontsLoaded"] == "loaded", result
    assert layout["hasSsrHtml"], result
    assert layout["activeMarket"] == market, result
    assert layout["marketCount"] == (6 if market == "CN" else 4), result
    assert layout["sectorCount"] == 11, result
    assert layout["sectorColumnCount"] == (2 if mobile else 6), result
    assert layout["indexColumnCount"] == (
        (3 if market == "CN" else 2) if mobile else layout["marketCount"]
    ), result
    assert layout["driverCount"] == 2, result
    assert layout["primaryDriverCount"] == 1, result
    assert layout["evidenceLinkCount"] >= layout["driverCount"], result
    assert layout["driverSectorChipCount"] >= layout["driverCount"], result
    assert layout["clippedContent"] == [], result
    assert layout["offCanvas"] == [], result
    assert layout["archiveCount"] == 0, result
    assert layout["dateNavigationCount"] == 0, result
    assert layout["legacyStoryCount"] == 0, result
    assert layout["weeklyEventCount"] == 0, result
    assert layout["thesisLedgerCount"] == 0, result
    assert layout["redundantHeadingCount"] == 0, result
    assert layout["confidenceLabelCount"] == 0, result
    assert layout["windowLabelCount"] == 0, result
    assert layout["pendingVerificationCount"] == 0, result
    assert layout["forbiddenCopy"] == [], result
    assert layout["rawTimestamps"] == [], result
    assert layout["coreDetailsCount"] == 0, result
    assert layout["sectionsInOrder"], result
    assert layout["marketAsOf"].endswith("收盘"), result
    assert all(height <= 70 for height in layout["sectorHeights"]), result
    assert audit["consoleErrors"] == [], result
    assert audit["httpErrors"] == [], result
    if mobile:
        assert audit["drawer"]["navigationCount"] == 2, result
        assert audit["drawer"]["hasArchiveAction"] == 0, result

assert result["CN-390"]["layout"]["heroHeadline"] != result["US-390"]["layout"][
    "heroHeadline"
], result
assert result["CN-390"]["layout"]["sourceLabels"] != result["US-390"][
    "layout"
]["sourceLabels"], result
assert result["english"] == {
    "lang": "en",
    "driverCount": 2,
    "hasEventLabel": 2,
    "hasMechanismLabel": 2,
    "hasGenericHeadline": False,
}, result

print(json.dumps(result, ensure_ascii=False, indent=2))
