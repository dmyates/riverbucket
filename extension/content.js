function detectFeeds() {
  return [...document.querySelectorAll('link[rel~="alternate"]')]
    .map((node) => ({
      title: node.getAttribute("title") || document.title || "Feed",
      feedUrl: new URL(node.getAttribute("href"), location.href).toString(),
      siteUrl: location.href,
      type: node.getAttribute("type") || ""
    }))
    .filter((item) => /rss|atom|json/i.test(item.type));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "riverbucket:feeds") {
    sendResponse({ feeds: detectFeeds(), title: document.title, url: location.href });
    return true;
  }
  if (message?.type === "riverbucket:toast") {
    showRiverbucketToast(message);
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

function showRiverbucketToast(message) {
  const existing = document.querySelector(".riverbucket-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `riverbucket-toast riverbucket-toast--${message.kind || "success"}`;
  toast.setAttribute("role", "status");
  const logo = document.createElement("img");
  logo.className = "riverbucket-toast__logo";
  logo.src = chrome.runtime.getURL("icons/icon-48.png");
  logo.alt = "";
  const copy = document.createElement("div");
  copy.className = "riverbucket-toast__copy";
  const title = document.createElement("strong");
  title.textContent = message.title || "Riverbucket";
  const text = document.createElement("span");
  text.textContent = message.text || "Added to bucket";
  copy.append(title, text);
  toast.append(logo, copy);

  const style = document.createElement("style");
  style.textContent = `
    .riverbucket-toast {
      --riverbucket-bg: #f3e7d2;
      --riverbucket-surface: #fff7ea;
      --riverbucket-ink: #0b2230;
      --riverbucket-muted: #4f6261;
      --riverbucket-rule: #b9a98e;
      --riverbucket-rule-strong: #7e8e8a;
      --riverbucket-accent: #934615;
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 2147483647;
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
      max-width: min(360px, calc(100vw - 36px));
      min-height: 66px;
      padding: 12px 15px 12px 12px;
      border: 1px solid var(--riverbucket-rule-strong);
      border-radius: 0;
      color: var(--riverbucket-ink);
      background: var(--riverbucket-surface);
      box-shadow: 0 18px 44px rgba(11, 34, 48, 0.2);
      font: 14px/1.35 "IBM Plex Serif", Georgia, serif;
      letter-spacing: 0;
    }
    @media (prefers-color-scheme: dark) {
      .riverbucket-toast {
        --riverbucket-bg: #071a24;
        --riverbucket-surface: #0c2430;
        --riverbucket-ink: #d8a15f;
        --riverbucket-muted: #a9794f;
        --riverbucket-rule: #25424e;
        --riverbucket-rule-strong: #43616b;
        --riverbucket-accent: #d47a2c;
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
      }
    }
    .riverbucket-toast--duplicate {
      border-color: var(--riverbucket-rule);
    }
    .riverbucket-toast--error {
      border-color: var(--riverbucket-accent);
    }
    .riverbucket-toast__logo {
      display: block;
      width: 40px;
      height: 40px;
      border: 1px solid var(--riverbucket-rule);
      border-radius: 6px;
      filter: saturate(0.9);
    }
    .riverbucket-toast__copy {
      min-width: 0;
      border-left: 1px solid var(--riverbucket-rule);
      padding-left: 12px;
    }
    .riverbucket-toast--error .riverbucket-toast__copy {
      border-left-color: var(--riverbucket-accent);
    }
    .riverbucket-toast strong,
    .riverbucket-toast span {
      display: block;
      overflow-wrap: anywhere;
    }
    .riverbucket-toast strong {
      margin: 0 0 4px;
      color: var(--riverbucket-ink);
      font-size: 15px;
      font-weight: 600;
      line-height: 1.1;
      text-transform: uppercase;
    }
    .riverbucket-toast span {
      color: var(--riverbucket-muted);
      font: 12px/1.35 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
  `;
  style.dataset.riverbucketToast = "true";

  document.querySelector("style[data-riverbucket-toast]")?.remove();
  document.documentElement.append(style, toast);
  window.setTimeout(() => toast.remove(), message.duration || 2600);
}
