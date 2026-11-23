/**
 * Jeet fork: data dashboard collectors.
 *
 * Every platform is read with the browser's own login: the collector opens the platform's
 * creator / profile page in a background tab, lets the page load its own data (captured by
 * contents/jeet-sniff.ts) or calls the page's own internal API, then closes the tab.
 * Results are stored in this browser's IndexedDB only.
 */
import {
  type AccountStats,
  type CollectResult,
  type PostStats,
  type SummaryItem,
  parseThreads,
  parseTikTok,
  parseX,
  parseXhs,
  parseYouTube,
} from "./analytics-parsers";
import { openDb } from "./scheduler";
import { parseChats } from "./telegram";

export const ANALYTICS_PLATFORMS = ["xhs", "threads", "x", "tiktok", "youtube", "tg"] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

export class NotLoggedInError extends Error {
  constructor(platform: string) {
    super(`${platform} 没有登录（在这个 Chrome 里登录后再更新）`);
    this.name = "NotLoggedInError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MARK = "#jeet-collect";

/* ---------- 后台标签页 ---------- */

async function waitTabComplete(tabId: number, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId); // 标签页被关掉时会直接报错
    if (t.status === "complete") return t;
    await sleep(400);
  }
  return chrome.tabs.get(tabId);
}

async function openProbe(url: string) {
  const tab = await chrome.tabs.create({ url, active: false });
  const id = tab.id as number;
  await sleep(500);
  await waitTabComplete(id);
  return id;
}

async function gotoProbe(tabId: number, url: string) {
  await chrome.tabs.update(tabId, { url });
  await sleep(800);
  await waitTabComplete(tabId);
}

function closeProbe(tabId: number | undefined) {
  if (tabId !== undefined) chrome.tabs.remove(tabId).catch(() => {});
}

async function tabUrl(tabId: number) {
  try {
    return (await chrome.tabs.get(tabId)).url || "";
  } catch {
    return "";
  }
}

async function inPage<T>(
  tabId: number,
  func: (...a: any[]) => T | Promise<T>,
  args: unknown[] = [],
): Promise<T | undefined> {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: func as any,
      args: args as any[],
    });
    return r?.result as T;
  } catch (e) {
    console.debug("inPage failed", e);
    return undefined;
  }
}

/** Poll a page function until it returns something truthy. */
async function waitFor<T>(tabId: number, func: (...a: any[]) => T | Promise<T>, timeout = 20000, args: unknown[] = []) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await inPage<T>(tabId, func, args);
    if (v) return v;
    await sleep(800);
  }
  return undefined;
}

interface CapSpec {
  re: string;
  has?: string;
}

function readCapsInPage(re: string, has: string) {
  const s = (window as any).__jeetSniff;
  if (!s) return null;
  const rx = new RegExp(re);
  return (s.caps as { url: string; body: string }[])
    .filter((c) => rx.test(c.url) && (!has || c.body.includes(has)))
    .map((c) => c.body);
}

/** Wait until every spec has at least one captured response (or the timeout). */
async function waitCaps(tabId: number, specs: CapSpec[], timeout = 25000, settleMs = 1500) {
  const end = Date.now() + timeout;
  let out: string[][] = specs.map(() => []);
  while (Date.now() < end) {
    out = [];
    for (const s of specs) out.push((await inPage<string[] | null>(tabId, readCapsInPage, [s.re, s.has || ""])) || []);
    if (out.every((a) => a.length)) {
      await sleep(settleMs); // 给分页、追加请求一点时间
      out = [];
      for (const s of specs)
        out.push((await inPage<string[] | null>(tabId, readCapsInPage, [s.re, s.has || ""])) || []);
      return out;
    }
    await sleep(800);
  }
  return out;
}

/* ---------- X ---------- */

async function collectX(): Promise<CollectResult> {
  let tab: number | undefined;
  try {
    tab = await openProbe(`https://x.com/home${MARK}`);
    const handle = await waitFor<string | null>(tab, () => {
      const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      const h = a?.getAttribute("href");
      if (h) return h.replace(/^\//, "");
      if (/\/login|\/i\/flow|\/logout/.test(location.pathname)) return "__login";
      if (document.querySelector('a[href="/login"], [data-testid="loginButton"]')) return "__login";
      return null;
    });
    if (!handle || handle === "__login") throw new NotLoggedInError("X");
    await gotoProbe(tab, `https://x.com/${handle}${MARK}`);
    const [users, tweets] = await waitCaps(tab, [{ re: "/UserByScreenName" }, { re: "/UserTweets" }]);
    if (!users.length) throw new Error("没有读到 X 主页数据，可能是页面改版或网络慢");
    return parseX(users, tweets, handle);
  } finally {
    closeProbe(tab);
  }
}

/* ---------- YouTube ---------- */

async function ytStudioFetch() {
  const cfg = (window as any).ytcfg;
  if (!cfg?.get) return { error: "no-ytcfg" };
  const channelId = cfg.get("CHANNEL_ID");
  if (!channelId) return { error: "no-channel" };
  const ck = Object.fromEntries(
    document.cookie.split("; ").map((s) => {
      const i = s.indexOf("=");
      return [s.slice(0, i), s.slice(i + 1)];
    }),
  );
  const sap = ck.SAPISID || ck["__Secure-3PAPISID"];
  if (!sap) return { error: "no-sapisid" };
  const ts = Math.floor(Date.now() / 1000);
  const origin = location.origin;
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${ts} ${sap} ${origin}`));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `SAPISIDHASH ${ts}_${hash}`,
    "x-origin": origin,
    "x-goog-authuser": String(cfg.get("SESSION_INDEX") ?? 0),
    "x-youtube-client-name": "62",
    "x-youtube-client-version": String(cfg.get("INNERTUBE_CLIENT_VERSION") || ""),
  };
  const pageId = cfg.get("DELEGATED_SESSION_ID");
  if (pageId) headers["x-goog-pageid"] = String(pageId);
  const call = async (ep: string, b: Record<string, unknown>) => {
    const r = await fetch(`/youtubei/v1/${ep}?alt=json&key=${cfg.get("INNERTUBE_API_KEY")}`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context: cfg.get("INNERTUBE_CONTEXT"), ...b }),
    });
    return r.ok ? r.json() : { error: `HTTP ${r.status}` };
  };
  const channels = await call("creator/get_creator_channels", {
    channelIds: [channelId],
    mask: { channelId: true, title: true, metric: { all: true } },
  });
  const videos = await call("creator/list_creator_videos", {
    filter: { and: { operands: [{ channelIdIs: { value: channelId } }] } },
    order: "VIDEO_ORDER_DISPLAY_TIME_DESC",
    pageSize: 30,
    mask: { videoId: true, title: true, timePublishedSeconds: true, privacy: true, metrics: { all: true } },
  });
  return { channelId, channels, videos };
}

async function collectYouTube(): Promise<CollectResult> {
  let tab: number | undefined;
  try {
    tab = await openProbe("https://studio.youtube.com/");
    const ready = await waitFor<string | null>(
      tab,
      () => {
        if (/accounts\.google\.com/.test(location.host)) return "login";
        const c = (window as any).ytcfg?.get?.("CHANNEL_ID");
        return c ? "ok" : null;
      },
      30000,
    );
    if (ready !== "ok") {
      if (ready === "login" || /accounts\.google\.com/.test(await tabUrl(tab))) throw new NotLoggedInError("YouTube");
      throw new Error("没有找到 YouTube 频道（可能还没创建频道）");
    }
    const data = await inPage<any>(tab, ytStudioFetch);
    if (!data || data.error) throw new Error(`读取 YouTube Studio 失败：${data?.error || "无响应"}`);
    if (data.channels?.error) throw new Error(`读取频道数据失败：${data.channels.error}`);
    return parseYouTube(data.channels, data.videos, data.channelId);
  } finally {
    closeProbe(tab);
  }
}

/* ---------- TikTok ---------- */

async function collectTikTok(): Promise<CollectResult> {
  let tab: number | undefined;
  try {
    tab = await openProbe(`https://www.tiktok.com/tiktokstudio/content${MARK}`);
    const username = await waitFor<string | null>(tab, async () => {
      try {
        const r = await fetch("/passport/web/account/info/?aid=1988", { credentials: "include" });
        const j = await r.json();
        return j?.data?.username || "__login";
      } catch {
        return null;
      }
    });
    if (!username || username === "__login") throw new NotLoggedInError("TikTok");
    const [studioItems] = await waitCaps(tab, [{ re: "/tiktok/creator/manage/item_list" }], 8000, 500);

    await gotoProbe(tab, `https://www.tiktok.com/@${username}${MARK}`);
    const userInfo = await waitFor<any>(tab, () => {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!el?.textContent) return null;
      try {
        const j = JSON.parse(el.textContent);
        return j.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo || null;
      } catch {
        return null;
      }
    });
    if (!userInfo) throw new Error("没有读到 TikTok 主页数据（可能弹出了验证）");
    const [profileItems] = await waitCaps(tab, [{ re: "/api/post/item_list" }], 10000, 800);
    return parseTikTok(userInfo, [...profileItems, ...studioItems], username);
  } finally {
    closeProbe(tab);
  }
}

/* ---------- 小红书 ---------- */

async function collectXhs(): Promise<CollectResult> {
  let tab: number | undefined;
  try {
    tab = await openProbe(`https://creator.xiaohongshu.com/new/home${MARK}`);
    await sleep(1000);
    if (/\/login/.test(await tabUrl(tab))) throw new NotLoggedInError("小红书");
    const [personal, base] = await waitCaps(tab, [
      { re: "/creator/home/personal_info" },
      { re: "/datacenter/account/base" },
    ]);
    if (!personal.length) {
      if (/\/login/.test(await tabUrl(tab))) throw new NotLoggedInError("小红书");
      throw new Error("没有读到小红书创作者中心数据");
    }
    await gotoProbe(tab, `https://creator.xiaohongshu.com/new/note-manager${MARK}`);
    const [posted] = await waitCaps(tab, [{ re: "/creator/note/user/posted" }], 20000);
    return parseXhs(personal, base, posted);
  } finally {
    closeProbe(tab);
  }
}

/* ---------- Threads ---------- */

function threadsEmbeddedInPage(marker: string) {
  return [...document.querySelectorAll('script[type="application/json"]')]
    .map((s) => s.textContent || "")
    .filter((t) => t.includes(marker));
}

async function collectThreads(): Promise<CollectResult> {
  let tab: number | undefined;
  try {
    tab = await openProbe(`https://www.threads.com/${MARK}`);
    const handle = await waitFor<string | null>(tab, () => {
      const ins = document.querySelector('a[href="/insights/"]');
      if (!ins) return /\/login/.test(location.pathname) ? "__login" : null;
      let box: Element | null = ins;
      for (let i = 0; i < 8 && box; i++) {
        box = box.parentElement;
        const a = box?.querySelector('a[href^="/@"]');
        if (a) return (a.getAttribute("href") || "").slice(2).replace(/\/$/, "");
      }
      return "__unknown";
    });
    if (!handle || handle === "__login") throw new NotLoggedInError("Threads");
    const realHandle = handle === "__unknown" ? "" : handle;

    // 在页面里切到“成效分析”，让 Threads 自己去取数据
    await inPage(tab, () => {
      history.pushState({}, "", "/insights/");
      dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      return true;
    });
    let [acct, posts] = await waitCaps(tab, [
      { re: "graphql", has: "engagement_summary" },
      { re: "graphql", has: "XDTTextAppContentInsightsPostsNode" },
    ]);
    if (!acct.length && !posts.length) {
      // 兜底：直接打开成效分析页，读取页面里内嵌的数据
      await gotoProbe(tab, `https://www.threads.com/insights/${MARK}`);
      const caps = await waitCaps(
        tab,
        [
          { re: "graphql", has: "engagement_summary" },
          { re: "graphql", has: "XDTTextAppContentInsightsPostsNode" },
        ],
        15000,
      );
      acct = caps[0].length
        ? caps[0]
        : (await inPage<string[]>(tab, threadsEmbeddedInPage, ["engagement_summary"])) || [];
      posts = caps[1].length
        ? caps[1]
        : (await inPage<string[]>(tab, threadsEmbeddedInPage, ["XDTTextAppContentInsightsPostsNode"])) || [];
    }
    if (!acct.length && !posts.length) throw new Error("没有读到 Threads 成效分析数据");
    return parseThreads(acct, posts, realHandle);
  } finally {
    closeProbe(tab);
  }
}

/* ---------- Telegram（机器人接口：只有订阅数） ---------- */

async function collectTelegram(): Promise<CollectResult> {
  let tg: { token?: string; chats?: string } | undefined;
  try {
    tg = JSON.parse(localStorage.getItem("pub.settings.v1") || "{}")?.tg;
  } catch {
    /* ignore */
  }
  const chats = parseChats(tg?.chats || "");
  if (!tg?.token || !chats.length) throw new Error("还没设置 Telegram 机器人和频道");
  let total = 0;
  const names: string[] = [];
  for (const chat_id of chats) {
    const call = async (method: string) => {
      const r = await fetch(`https://api.telegram.org/bot${tg?.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`);
      return j.result;
    };
    total += Number(await call("getChatMemberCount")) || 0;
    const c = await call("getChat");
    names.push(c.title || (c.username ? `@${c.username}` : String(chat_id)));
  }
  return { account: { name: names.join("、"), followers: total }, posts: [] };
}

const COLLECTORS: Record<AnalyticsPlatform, () => Promise<CollectResult>> = {
  xhs: collectXhs,
  threads: collectThreads,
  x: collectX,
  tiktok: collectTikTok,
  youtube: collectYouTube,
  tg: collectTelegram,
};

/* ---------- 本地存储 ---------- */

export interface Metrics {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
}

export interface AcctSnapshot {
  id?: number;
  platform: string;
  at: number;
  day: string;
  account: AccountStats;
  summary?: SummaryItem[];
  summaryLabel?: string;
}

export interface PostRecord {
  key: string;
  platform: string;
  id: string;
  title: string;
  url?: string;
  publishedAt?: number;
  type?: string;
  metrics: Metrics;
  firstSeen: number;
  updatedAt: number;
  history: (Metrics & { at: number; day: string })[];
}

export interface RunResult {
  platform: string;
  ok: boolean;
  msg: string;
  posts?: number;
}

export interface CollectRun {
  id?: number;
  at: number;
  finishedAt?: number;
  trigger: "manual" | "auto";
  results: RunResult[];
}

export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const r = t.objectStore(store).getAll();
    r.onsuccess = () => resolve((r.result as T[]) || []);
    r.onerror = () => reject(r.error);
  });
}

async function putMany(store: string, items: unknown[]) {
  if (!items.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const s = t.objectStore(store);
    for (const it of items) s.put(it);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

const pickMetrics = (p: PostStats): Metrics => ({
  views: p.views,
  likes: p.likes,
  comments: p.comments,
  shares: p.shares,
  saves: p.saves,
});

export async function saveResult(platform: string, res: CollectResult, at = Date.now()) {
  const day = dayKey(at);
  await putMany("acct_snapshots", [
    { platform, at, day, account: res.account, summary: res.summary, summaryLabel: res.summaryLabel } as AcctSnapshot,
  ]);
  const existing = new Map((await getAll<PostRecord>("posts")).map((p) => [p.key, p]));
  const updates: PostRecord[] = [];
  for (const p of res.posts) {
    const key = `${platform}:${p.id}`;
    const old = existing.get(key);
    const m = pickMetrics(p);
    const history = (old?.history || []).filter((h) => h.day !== day);
    history.push({ ...m, at, day });
    updates.push({
      key,
      platform,
      id: p.id,
      title: p.title,
      url: p.url || old?.url,
      publishedAt: p.publishedAt ?? old?.publishedAt,
      type: p.type || old?.type,
      metrics: m,
      firstSeen: old?.firstSeen ?? at,
      updatedAt: at,
      history: history.slice(-90),
    });
  }
  await putMany("posts", updates);
}

export async function loadDashboardData() {
  const [snapshots, posts, runs] = await Promise.all([
    getAll<AcctSnapshot>("acct_snapshots"),
    getAll<PostRecord>("posts"),
    getAll<CollectRun>("collect_runs"),
  ]);
  return {
    snapshots: snapshots.sort((a, b) => a.at - b.at),
    posts,
    runs: runs.sort((a, b) => b.at - a.at),
  };
}

export async function clearDashboardData() {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(["acct_snapshots", "posts", "collect_runs"], "readwrite");
    t.objectStore("acct_snapshots").clear();
    t.objectStore("posts").clear();
    t.objectStore("collect_runs").clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ---------- 采集入口 ---------- */

const LOCK_KEY = "jeet.analytics.running";
const LOCK_MS = 15 * 60 * 1000;

/** 当前浏览器里打开了哪些平台（平台设置里的勾选） */
export function enabledAnalyticsPlatforms(): AnalyticsPlatform[] {
  let enabled: string[] = ["xhs", "threads", "x", "tiktok", "youtube"];
  try {
    const s = JSON.parse(localStorage.getItem("pub.settings.v1") || "null");
    if (Array.isArray(s?.enabled)) enabled = s.enabled;
  } catch {
    /* ignore */
  }
  return ANALYTICS_PLATFORMS.filter((p) => enabled.includes(p));
}

export async function collectAll(
  platforms: AnalyticsPlatform[],
  trigger: "manual" | "auto",
  onProgress?: (msg: string, results: RunResult[]) => void,
): Promise<CollectRun | null> {
  const lock = (await chrome.storage.local.get(LOCK_KEY))[LOCK_KEY];
  if (lock && Date.now() - Number(lock) < LOCK_MS) {
    onProgress?.("已经有一次数据更新在进行中，请稍后再试", []);
    return null;
  }
  await chrome.storage.local.set({ [LOCK_KEY]: Date.now() });
  const run: CollectRun = { at: Date.now(), trigger, results: [] };
  try {
    for (const p of platforms) {
      onProgress?.(`正在读取 ${PLATFORM_NAMES[p]}…`, run.results);
      try {
        const res = await COLLECTORS[p]();
        await saveResult(p, res);
        run.results.push({ platform: p, ok: true, msg: "已更新", posts: res.posts.length });
      } catch (e) {
        run.results.push({ platform: p, ok: false, msg: (e as Error).message || String(e) });
      }
    }
  } finally {
    run.finishedAt = Date.now();
    await putMany("collect_runs", [run]);
    await chrome.storage.local.remove(LOCK_KEY);
  }
  onProgress?.("全部完成", run.results);
  return run;
}

export const PLATFORM_NAMES: Record<string, string> = {
  xhs: "小红书",
  threads: "Threads",
  x: "X",
  tiktok: "TikTok",
  youtube: "YouTube",
  tg: "Telegram",
};
