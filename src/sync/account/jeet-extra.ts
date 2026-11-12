/**
 * Jeet fork: account detection for 小红书 (fallback) and Threads.
 */
import type { AccountInfo } from "~sync/common";
import { getRednoteAccountInfo } from "./rednote";
import { probeInTab } from "./tab-probe";

interface Probed {
  id: string;
  name: string;
  avatar?: string;
}

export async function getRednoteAccountInfoWithProbe(): Promise<AccountInfo> {
  try {
    const r = await getRednoteAccountInfo();
    if (r?.username) return r;
  } catch (e) {
    console.debug("rednote html parse failed, falling back to tab probe", e);
  }
  const p = await probeInTab<Probed>("https://www.xiaohongshu.com/explore", () => {
    // biome-ignore lint/suspicious/noExplicitAny: page globals
    const unwrap = (x: any) => (x && typeof x === "object" ? (x._rawValue ?? x._value ?? x.value ?? x) : x);
    // biome-ignore lint/suspicious/noExplicitAny: page globals
    const s = (window as any).__INITIAL_STATE__;
    const info = unwrap(s?.user?.userInfo);
    if (info?.nickname) return { id: info.user_id || info.userId || "", name: info.nickname, avatar: info.images };
    const link = document.querySelector('a[href*="/user/profile/"]') as HTMLAnchorElement | null;
    const side = document.querySelector(".side-bar .user, .side-bar a[href*='/user/profile/']");
    if (link && side) {
      const id = link.href.split("/user/profile/")[1]?.split(/[?#/]/)[0] || "";
      const name = (side.textContent || "").replace("我", "").trim();
      if (id) return { id, name: name || id };
    }
    return null;
  });
  if (!p) return null;
  return {
    provider: "rednote",
    accountId: p.id,
    username: p.name,
    profileUrl: p.id ? `https://www.xiaohongshu.com/user/profile/${p.id}` : "https://www.xiaohongshu.com",
    avatarUrl: p.avatar,
  };
}

export async function getThreadsAccountInfo(): Promise<AccountInfo> {
  const p = await probeInTab<Probed>("https://www.threads.com/", () => {
    const labels = /^(Profile|个人主页|主页|個人檔案|个人资料)$/i;
    const svgs = Array.from(document.querySelectorAll("svg[aria-label]"));
    for (const svg of svgs) {
      if (!labels.test(svg.getAttribute("aria-label") || "")) continue;
      const a = svg.closest("a") as HTMLAnchorElement | null;
      const m = a?.getAttribute("href")?.match(/^\/@([^/?#]+)/);
      if (m) return { id: m[1], name: m[1] };
    }
    return null;
  });
  if (!p) return null;
  return {
    provider: "threads",
    accountId: p.id,
    username: p.id,
    profileUrl: `https://www.threads.com/@${p.id}`,
  };
}
