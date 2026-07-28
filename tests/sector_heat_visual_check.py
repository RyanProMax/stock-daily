import json
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("STOCK_DAILY_URL", "http://127.0.0.1:8788").rstrip("/")
CHROME_PATH = os.environ.get(
    "CHROME_PATH",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
SCREENSHOT_DIR = Path("artifacts/screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
SCREENSHOT_LABEL = os.environ.get(
    "SECTOR_HEAT_SCREENSHOT_LABEL", "sector-heat-local"
)


def inspect(browser, viewport, language, market, label):
    page = browser.new_page(viewport=viewport)
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
        f"{BASE_URL}/?date=2026-07-22&lang={language}&market={market.lower()}",
        wait_until="networkidle",
    )
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(400)
    page.add_style_tag(
        content=(
            ".masthead { position: static !important; } "
            ".skip-link { display: none !important; }"
        )
    )
    page.locator(".market-section").screenshot(
        path=str(SCREENSHOT_DIR / f"{label}.png")
    )

    result = page.evaluate(
        """() => {
          const rows = [...document.querySelectorAll('.heat-item')];
          const shortText = [...document.querySelectorAll(
            '.heat-heading strong, .heat-heading span, ' +
            '.heat-streaks > header strong, ' +
            '.heat-streaks > div > span'
          )];
          const heatNames = [...document.querySelectorAll('.heat-item-top a')]
            .map((element) => element.textContent.trim());
          return {
            viewportWidth: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            fontsLoaded: document.fonts.status,
            ssr: Boolean(document.querySelector('[data-render="ssr"]')),
            dateNavCount: document.querySelectorAll('.date-nav').length,
            nestedHeatDateControls: document.querySelectorAll(
              '.heat-date-rail, .heat-date-nav, .heat-timeline, .heat-tabs'
            ).length,
            marketHeaderCount: document.querySelectorAll(
              '.heat-market > header'
            ).length,
            cnCount: document.querySelectorAll('.heat-market-cn .heat-item').length,
            usCount: document.querySelectorAll('.heat-market-us .heat-item').length,
            heatNames,
            activeMarket: document.querySelector(
              '.market-switcher a[aria-current="page"]'
            )?.textContent.trim(),
            forbiddenHeatNames: heatNames.filter(
              (name) => ['人工智能', '美股', '原油'].includes(name)
            ),
            rowHeights: rows.map(
              (element) => Math.round(element.getBoundingClientRect().height * 100) / 100
            ),
            wrappedShortText: shortText
              .filter((element) => element.scrollHeight > element.clientHeight + 1)
              .map((element) => element.textContent.trim()),
            streakCount: document.querySelectorAll(
              '.heat-streaks > div > span'
            ).length,
            streakText: document.querySelector('.heat-streaks')?.textContent.trim(),
            heatFont: getComputedStyle(
              document.querySelector('.heat-item-top a')
            ).fontFamily
          };
        }"""
    )
    result["consoleErrors"] = console_errors
    result["httpErrors"] = http_errors
    page.close()
    return result


def inspect_edition_navigation(browser):
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.goto(f"{BASE_URL}/?lang=zh", wait_until="networkidle")
    current_names = page.locator(
        ".heat-market-cn .heat-item-top a"
    ).all_text_contents()
    page.locator(".date-select-trigger").click()
    page.get_by_role(
        "option", name=re.compile(r"^2026-07-22")
    ).click()
    page.wait_for_url(re.compile(r"date=2026-07-22"))
    page.wait_for_load_state("networkidle")
    selected_names = page.locator(
        ".heat-market-cn .heat-item-top a"
    ).all_text_contents()
    result = {
        "dateNavCount": page.locator(".date-nav").count(),
        "selectedUrl": page.url,
        "currentNames": current_names,
        "selectedNames": selected_names,
    }
    page.close()
    return result


with sync_playwright() as playwright:
    launch_options = {
        "headless": True,
        "args": ["--disable-dev-shm-usage"],
    }
    if CHROME_PATH:
        launch_options["executable_path"] = CHROME_PATH
    browser = playwright.chromium.launch(**launch_options)
    result = {
        "mobileCnZh": inspect(
            browser,
            {"width": 390, "height": 844},
            "zh",
            "CN",
            f"{SCREENSHOT_LABEL}-mobile-390-cn",
        ),
        "desktopCnZh": inspect(
            browser,
            {"width": 1440, "height": 1000},
            "zh",
            "CN",
            f"{SCREENSHOT_LABEL}-desktop-1440-cn",
        ),
        "mobileUsEn": inspect(
            browser,
            {"width": 390, "height": 844},
            "en",
            "US",
            f"{SCREENSHOT_LABEL}-mobile-390-us-en",
        ),
        "editionNavigation": inspect_edition_navigation(browser),
    }
    browser.close()

for audit in (
    result["mobileCnZh"],
    result["desktopCnZh"],
    result["mobileUsEn"],
):
    assert audit["scrollWidth"] <= audit["viewportWidth"], result
    assert audit["fontsLoaded"] == "loaded", result
    assert audit["ssr"], result
    assert audit["dateNavCount"] == 1, result
    assert audit["nestedHeatDateControls"] == 0, result
    assert audit["marketHeaderCount"] == 0, result
    expected_cn = 3 if audit["activeMarket"] == "CN" else 0
    expected_us = 3 if audit["activeMarket"] == "US" else 0
    assert audit["cnCount"] == expected_cn, result
    assert audit["usCount"] == expected_us, result
    assert audit["forbiddenHeatNames"] == [], result
    assert max(audit["rowHeights"]) - min(audit["rowHeights"]) <= 1, result
    assert audit["wrappedShortText"] == [], result
    if audit["activeMarket"] == "CN":
        assert audit["streakCount"] >= 1, result
    else:
        assert audit["streakCount"] == 0, result
        assert "No sector has stayed hot" in audit["streakText"], result
    assert audit["consoleErrors"] == [], result
    assert audit["httpErrors"] == [], result
    assert "Noto Sans SC Variable" in audit["heatFont"], result

assert "连续 3 个交易日" in result["mobileCnZh"]["streakText"], result
assert result["editionNavigation"]["dateNavCount"] == 1, result
assert "date=2026-07-22" in result["editionNavigation"]["selectedUrl"], result
assert len(result["editionNavigation"]["currentNames"]) == 3, result
assert (
    result["editionNavigation"]["currentNames"]
    != result["editionNavigation"]["selectedNames"]
), result
assert result["editionNavigation"]["selectedNames"] == [
    "信息技术",
    "通信服务",
    "原材料",
], result
print(json.dumps(result, ensure_ascii=False, indent=2))
