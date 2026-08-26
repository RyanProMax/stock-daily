import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/noto-serif-sc/wght.css";
import { hydrateRoot } from "react-dom/client";
import Document, { type PageData } from "./App";
import "./styles.css";

const payload = document.querySelector<HTMLScriptElement>("#stock-daily-data");

if (payload?.textContent) {
  const data = JSON.parse(payload.textContent) as PageData;
  hydrateRoot(document, <Document data={data} />);
}

const isLocalPreview =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

if ("serviceWorker" in navigator && isLocalPreview) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())),
      );
    if ("caches" in window) {
      void caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith("stock-daily-"))
              .map((key) => caches.delete(key)),
          ),
        );
    }
  });
} else if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
  });
}
