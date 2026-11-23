/**
 * Jeet fork: data-dashboard capture hook.
 *
 * Runs in the page's own JS world at document_start on the creator / profile pages we read data from.
 * It does nothing unless the tab was opened by the dashboard collector (URL hash contains
 * "jeet-collect"); then it keeps a copy of the page's own API responses in memory
 * (window.__jeetSniff) so the collector can read them. Nothing is sent anywhere.
 */
import type { PlasmoCSConfig } from "plasmo";

export const config: PlasmoCSConfig = {
  matches: [
    "https://x.com/*",
    "https://www.tiktok.com/*",
    "https://creator.xiaohongshu.com/*",
    "https://www.threads.com/*",
    "https://www.threads.net/*",
  ],
  world: "MAIN",
  run_at: "document_start",
};

const MARK = "jeet-collect";
const FLAG = "__jeet_collect";
const URL_RE = /graphql|\/api\/|web_api|youtubei|\/tiktok\//;
const MAX_ITEMS = 300;
const MAX_BODY = 4_000_000;

interface Cap {
  url: string;
  body: string;
  at: number;
}

(() => {
  try {
    const marked = location.hash.includes(MARK);
    if (marked) sessionStorage.setItem(FLAG, "1");
    if (!marked && sessionStorage.getItem(FLAG) !== "1") return;
  } catch {
    return;
  }

  const w = window as any;
  if (w.__jeetSniff) return;
  const store: { caps: Cap[] } = { caps: [] };
  w.__jeetSniff = store;

  const keep = (url: unknown, body: unknown) => {
    try {
      const u = String(url || "");
      if (!URL_RE.test(u)) return;
      const b = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
      if (!b || b.length > MAX_BODY) return;
      store.caps.push({ url: u, body: b, at: Date.now() });
      if (store.caps.length > MAX_ITEMS) store.caps.shift();
    } catch {
      /* ignore */
    }
  };

  const origFetch = window.fetch;
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === "string" ? req : req instanceof URL ? req.href : (req as unknown as Request).url;
      const ct = res.headers.get("content-type") || "";
      if (URL_RE.test(url) && !/image|video|audio|octet-stream/.test(ct)) {
        res
          .clone()
          .text()
          .then((t) => keep(url, t))
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
    return res;
  } as typeof fetch;

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: any, ...a: any[]) {
    this.__jeetUrl = String(a[1] || "");
    return (XO as any).apply(this, a);
  };
  XMLHttpRequest.prototype.send = function (this: any, ...a: any[]) {
    this.addEventListener("load", () => {
      try {
        if (this.responseType === "" || this.responseType === "text") keep(this.__jeetUrl, this.responseText);
        else if (this.responseType === "json") keep(this.__jeetUrl, this.response);
      } catch {
        /* ignore */
      }
    });
    return (XS as any).apply(this, a);
  };
})();
