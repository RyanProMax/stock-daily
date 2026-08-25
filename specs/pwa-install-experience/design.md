# PWA Install Experience Design

## Visual direction

The installed application continues the existing editorial / magazine system:
paper `#f5f0e6`, deep green `#123b34`, ink `#132621`, coral `#c85a43` and mint
`#77d6c8`. The icon uses an asymmetric masthead composition with an `SD` monogram,
a fine rule and coral issue marks. It is designed inside the maskable safe zone.

## Runtime behavior

- The manifest launches `/` inside the root scope in standalone mode.
- Apple metadata and a 180px icon cover iOS home-screen installation.
- Standalone CSS adds only safe-area padding and minimum viewport sizing.
- The service worker precaches icons, manifest and the offline document.
- Same-origin fingerprinted `/static/` files use cache-first delivery.
- Navigations and dynamic requests remain network-only; an offline navigation falls
  back to the dedicated offline document instead of an old report.

## Verification

Manifest and head metadata are covered by deterministic tests. Build output is
served locally for browser console, install-asset, desktop and mobile layout checks.
Full-page screenshots and expanded core-signal screenshots are reviewed before the
change can be committed.
