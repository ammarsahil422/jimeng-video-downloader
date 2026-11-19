import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

// Phase 5 — PWA: link the web manifest and icons served from the site
// root (/manifest.webmanifest, /icon-192.png). Injected at runtime so
// Bun.build does not try to bundle the link tags from index.html.
if (typeof document !== "undefined") {
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = "/manifest.webmanifest";
    document.head.appendChild(link);
  }
  if (!document.querySelector('link[rel="icon"]')) {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = "image/png";
    icon.href = "/icon-192.png";
    document.head.appendChild(icon);
    const apple = document.createElement("link");
    apple.rel = "apple-touch-icon";
    apple.href = "/icon-192.png";
    document.head.appendChild(apple);
  }
}

// Phase 5 — PWA: register the service worker (app-shell caching; the
// API and prepared files are never cached). A failed registration is
// silent — the site works exactly the same without it.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  });
}

const rootEl = document.querySelector<HTMLElement>(
  "[data-generated-space-root]",
);
if (!rootEl) {
  throw new Error("missing root element");
}

const queryClient = new QueryClient();

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="hatch-space-root" data-hatch-space-root>
        <App />
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
