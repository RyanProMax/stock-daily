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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
  });
}
