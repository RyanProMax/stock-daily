# PWA Install Experience Requirements

## Goal

Make Stock Daily install cleanly on iOS and Android while preserving the existing
editorial interface and preventing stale market reports.

## Acceptance criteria

1. The document shall expose a standards-based web app manifest, application name,
   standalone display mode, theme/background colors and square icons at 192px and
   512px, including a maskable icon.
2. iOS shall receive a dedicated 180px touch icon, standalone metadata, status-bar
   styling and viewport safe-area support.
3. Installed-mode layout shall respect top and bottom safe areas without changing
   the existing reader hierarchy or causing horizontal overflow.
4. A service worker shall cache only versioned static assets and a branded offline
   page. It shall not cache report HTML or dynamic data responses.
5. The service worker and manifest shall use cache headers that allow prompt update
   checks; fingerprinted static assets may remain immutable.
6. Desktop 1440px and mobile 390px full-page screenshots, including expanded core
   signal states, shall pass automated overflow checks and visual review.
