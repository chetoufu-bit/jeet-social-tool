import type { AccountInfo } from "~sync/common";

/**
 * Jeet fork: best-effort YouTube login detection.
 * 1. Open YouTube Studio with the browser's cookies. When logged in it lands on /channel/UC…
 * 2. Read the public channel page for the display name and @handle.
 * Returns null when not logged in.
 */
export async function getYoutubeAccountInfo(): Promise<AccountInfo> {
  const studio = await fetch("https://studio.youtube.com/", {
    method: "GET",
    headers: { Accept: "text/html" },
    credentials: "include",
  });

  if (studio.url.includes("accounts.google.com") || studio.url.includes("ServiceLogin")) {
    return null;
  }
  if (!studio.ok) {
    throw new Error(`HTTP错误，状态码: ${studio.status}`);
  }

  const studioHtml = await studio.text();
  if (/"LOGGED_IN"\s*:\s*false/.test(studioHtml)) {
    return null;
  }

  const channelId =
    studio.url.match(/\/channel\/(UC[\w-]{22})/)?.[1] ||
    studioHtml.match(/"CHANNEL_ID"\s*:\s*"(UC[\w-]{22})"/)?.[1] ||
    studioHtml.match(/"channelId"\s*:\s*"(UC[\w-]{22})"/)?.[1];

  if (!channelId) {
    return null;
  }

  let username = channelId;
  let handle = "";
  let avatarUrl: string | undefined;
  try {
    const channel = await fetch(`https://www.youtube.com/channel/${channelId}`, {
      headers: { Accept: "text/html" },
      credentials: "omit",
    });
    if (channel.ok) {
      const html = await channel.text();
      username = decodeHtml(html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] || channelId);
      handle = html.match(/"canonicalBaseUrl"\s*:\s*"\/(@[^"]+)"/)?.[1] || "";
      avatarUrl = html.match(/<meta property="og:image" content="([^"]*)"/)?.[1];
    }
  } catch (error) {
    console.debug("读取 YouTube 频道信息失败", error);
  }

  return {
    provider: "youtube",
    accountId: channelId,
    username: handle ? `${username} (${handle})` : username,
    profileUrl: `https://www.youtube.com/channel/${channelId}`,
    avatarUrl,
    extraData: { channelId, handle },
  };
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
