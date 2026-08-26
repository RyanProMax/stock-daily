import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("web app manifest exposes installable square and maskable icons", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("public/manifest.webmanifest", root), "utf8"),
  );
  assert.equal(manifest.name, "Stock Daily");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#123b34");
  assert.equal(manifest.background_color, "#f5f0e6");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
});

test("document includes iOS and standards-based installation metadata", async () => {
  const app = await readFile(new URL("src/App.tsx", root), "utf8");
  assert.match(app, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(app, /apple-mobile-web-app-capable/);
  assert.match(app, /apple-mobile-web-app-status-bar-style/);
  assert.match(app, /rel="apple-touch-icon"/);
  assert.match(app, /viewport-fit=cover/);
});

test("service worker never caches report navigations or dynamic data", async () => {
  const worker = await readFile(
    new URL("public/service-worker.js", root),
    "utf8",
  );
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /fetch\(request\)\.catch\(\(\) => caches\.match\("\/offline"\)\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/static\/"\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/static\/"\)[\s\S]*event\.respondWith\(fetch\(request\)\)/);
  assert.doesNotMatch(worker, /url\.pathname\.startsWith\("\/static\/"\)\s*\|\|\s*PRECACHE/);
  assert.doesNotMatch(worker, /cache\.put\([^\n]*navigate/);
  assert.doesNotMatch(worker, /PRECACHE[^;]*["']\/["']/s);
});

test("local preview removes stale PWA caches instead of registering a worker", async () => {
  const client = await readFile(new URL("src/client.tsx", root), "utf8");
  assert.match(client, /location\.hostname === "localhost"/);
  assert.match(client, /location\.hostname === "127\.0\.0\.1"/);
  assert.match(client, /getRegistrations\(\)/);
  assert.match(client, /registration\.unregister\(\)/);
  assert.match(client, /key\.startsWith\("stock-daily-"\)/);
});

test("PWA assets bypass the report worker and update-sensitive files revalidate", async () => {
  const routes = JSON.parse(
    await readFile(new URL("public/_routes.json", root), "utf8"),
  );
  for (const path of [
    "/manifest.webmanifest",
    "/service-worker.js",
    "/offline",
    "/apple-touch-icon.png",
  ]) {
    assert.ok(routes.exclude.includes(path), `${path} must bypass the report worker`);
  }
  const headers = await readFile(new URL("public/_headers", root), "utf8");
  assert.match(headers, /\/service-worker\.js\s+Cache-Control: no-cache, no-store, must-revalidate/s);
  assert.match(headers, /\/manifest\.webmanifest\s+Cache-Control: public, max-age=3600, must-revalidate/s);
});
