import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get(
    "STOCK_DAILY_URL", "https://stock-daily-4ip.pages.dev"
).rstrip("/")
CHROME_PATH = os.environ.get(
    "CHROME_PATH",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
SCREENSHOT_DIR = Path("artifacts/screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
AUDIT_LABEL = os.environ.get("STYLE_AUDIT_LABEL", "audit")

SELECTORS = {
    "brand": ".brand-copy strong",
    "date": ".date-select-trigger",
    "hero_title": ".hero h1",
    "section_title": ".section-intro h2",
    "market_name": ".snapshot-item-top span, .snapshot-item-top a",
    "market_value": ".snapshot-item strong",
    "market_change": ".snapshot-item-top em",
    "event_impact": "[data-event-impact]",
    "story_meta": ".hotspot-title > span",
    "story_title": ".hotspot-title > strong",
    "story_body": ".signal-fact-thesis > div:first-child p",
    "ai_label": ".signal-fact-thesis > div:last-child > strong",
    "ai_body": ".signal-fact-thesis > div:last-child p",
    "impact_tag": ".signal-exposure b",
}


def platform_fonts(cdp, selector):
    document = cdp.send("DOM.getDocument")
    node = cdp.send(
        "DOM.querySelector",
        {"nodeId": document["root"]["nodeId"], "selector": selector},
    )
    if not node.get("nodeId"):
        return []
    return cdp.send(
        "CSS.getPlatformFontsForNode", {"nodeId": node["nodeId"]}
    ).get("fonts", [])


def audit_page(browser, path, viewport, prefix):
    page = browser.new_page(viewport=viewport)
    errors = []
    page.on(
        "console",
        lambda message: errors.append(message.text)
        if message.type == "error"
        else None,
    )
    page.goto(f"{BASE_URL}{path}", wait_until="networkidle")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(500)
    page.screenshot(
        path=str(SCREENSHOT_DIR / f"{prefix}.png"),
        full_page=True,
    )
    # Full-page capture lays out off-screen text and may start additional
    # Unicode-range font downloads. Wait once more before auditing the result.
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(300)

    cdp = page.context.new_cdp_session(page)
    cdp.send("DOM.enable")
    cdp.send("CSS.enable")
    typography = {}
    for name, selector in SELECTORS.items():
        locator = page.locator(selector).first
        if locator.count() == 0:
            continue
        typography[name] = {
            "computed": locator.evaluate(
                """element => {
                  const style = getComputedStyle(element);
                  return {
                    family: style.fontFamily,
                    weight: style.fontWeight,
                    size: style.fontSize,
                    lineHeight: style.lineHeight,
                    letterSpacing: style.letterSpacing
                  };
                }"""
            ),
            "platform": platform_fonts(cdp, selector),
        }

    page.evaluate("document.fonts.ready")
    layout = page.evaluate(
        """() => {
          const shortSelectors = [
            '.control-button',
            '.date-select-trigger',
            '.sample-badge',
            '.impact-badge',
            '.category',
            '.importance',
            '.impact-tags > span',
            '.overview-impact-grid i'
          ].join(',');
          const boxes = [...document.querySelectorAll(shortSelectors)];
          const overlaps = [];
          const visible = [...document.querySelectorAll(
            '.masthead-inner > *, .hero-meta-row > *, .snapshot-item, .signal-meta > *'
          )].filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          for (let index = 0; index < visible.length; index += 1) {
            const a = visible[index].getBoundingClientRect();
            for (let other = index + 1; other < visible.length; other += 1) {
              const b = visible[other].getBoundingClientRect();
              const sameParent = visible[index].parentElement === visible[other].parentElement;
              if (!sameParent) continue;
              const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (width > 1 && height > 1) {
                overlaps.push([
                  visible[index].className,
                  visible[other].className
                ]);
              }
            }
          }
          return {
            viewport: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            shortTextWraps: boxes
              .filter(element => element.scrollHeight > element.clientHeight + 1)
              .map(element => element.textContent.trim()),
            overlaps
          };
        }"""
    )
    page.evaluate("document.fonts.ready")
    layout["fontStatus"] = page.evaluate("document.fonts.status")
    page.close()
    return {"typography": typography, "layout": layout, "errors": errors}


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=CHROME_PATH,
        args=["--disable-dev-shm-usage"],
    )
    result = {
        "mobile_daily": audit_page(
            browser,
            "/",
            {"width": 390, "height": 844},
            f"{AUDIT_LABEL}-mobile-daily",
        ),
        "desktop_daily": audit_page(
            browser,
            "/",
            {"width": 1440, "height": 1000},
            f"{AUDIT_LABEL}-desktop-daily",
        ),
        "mobile_weekly": audit_page(
            browser,
            "/weekly",
            {"width": 390, "height": 844},
            f"{AUDIT_LABEL}-mobile-weekly",
        ),
    }
    browser.close()

print(json.dumps(result, ensure_ascii=False, indent=2))
