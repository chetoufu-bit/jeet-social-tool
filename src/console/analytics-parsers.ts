/**
 * Jeet fork: turn each platform's own API responses into one shape for the data dashboard.
 * Pure functions (no chrome APIs) so they can be tested on their own.
 */

export interface AccountStats {
  name?: string;
  handle?: string;
  avatar?: string;
  url?: string;
  followers?: number;
  following?: number;
  posts?: number;
  /** likes received (TikTok 获赞, 小红书 获赞与收藏) */
  likes?: number;
  /** total views / plays where the platform reports it */
  views?: number;
}

export interface SummaryItem {
  label: string;
  value: number;
}

export interface PostStats {
  id: string;
  title: string;
  url?: string;
  publishedAt?: number;
  type?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
}

export interface CollectResult {
  account: AccountStats;
  posts: PostStats[];
  /** period summary shown on the platform card, e.g. 小红书近 7 天曝光 */
  summary?: SummaryItem[];
  summaryLabel?: string;
}

/* ---------- helpers ---------- */

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Parse JSON that may be prefixed (for (;;);) or be several JSON documents separated by new lines. */
export function parseLoose(body: string): any[] {
  const s = String(body || "")
    .replace(/^for \(;;\);/, "")
    .trim();
  if (!s) return [];
  try {
    return [JSON.parse(s)];
  } catch {
    const out: any[] = [];
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

function walk(o: any, visit: (node: any) => boolean | undefined, depth = 0) {
  if (!o || typeof o !== "object" || depth > 60) return;
  if (visit(o) === true) return;
  for (const k in o) walk(o[k], visit, depth + 1);
}

const clip = (s: unknown, n = 80) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

function dedupe(posts: PostStats[]) {
  const seen = new Map<string, PostStats>();
  for (const p of posts) if (p.id && !seen.has(p.id)) seen.set(p.id, p);
  return [...seen.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
}

/* ---------- X ---------- */

export function parseX(userBodies: string[], tweetBodies: string[], handle: string): CollectResult {
  const account: AccountStats = { handle, url: `https://x.com/${handle}` };
  for (const body of userBodies) {
    for (const j of parseLoose(body)) {
      const u = j?.data?.user?.result;
      if (!u) continue;
      const screen = u.core?.screen_name || u.legacy?.screen_name;
      if (screen && handle && screen.toLowerCase() !== handle.toLowerCase()) continue;
      account.name = u.core?.name || u.legacy?.name || account.name;
      account.handle = screen || handle;
      account.avatar = u.avatar?.image_url || u.legacy?.profile_image_url_https || account.avatar;
      account.followers = num(u.relationship_counts?.followers) ?? num(u.legacy?.followers_count) ?? account.followers;
      account.following = num(u.relationship_counts?.following) ?? num(u.legacy?.friends_count) ?? account.following;
      account.posts = num(u.tweet_counts?.tweets) ?? num(u.legacy?.statuses_count) ?? account.posts;
    }
  }

  const posts: PostStats[] = [];
  for (const body of tweetBodies) {
    for (const j of parseLoose(body)) {
      walk(j, (node) => {
        const t = node.__typename === "TweetWithVisibilityResults" ? node.tweet : node;
        if (!t || t.__typename !== "Tweet" || !t.legacy || !t.rest_id) return;
        const author =
          t.core?.user_results?.result?.core?.screen_name || t.core?.user_results?.result?.legacy?.screen_name;
        if (author && handle && author.toLowerCase() !== handle.toLowerCase()) return true;
        if (t.legacy.retweeted_status_result) return true; // 转推不算自己的内容
        const text = t.note_tweet?.note_tweet_results?.result?.text || t.legacy.full_text || "";
        const created = Date.parse(t.legacy.created_at);
        posts.push({
          id: String(t.rest_id),
          title: clip(text) || "(无文字)",
          url: `https://x.com/${handle}/status/${t.rest_id}`,
          publishedAt: Number.isFinite(created) ? created : undefined,
          type: t.legacy.in_reply_to_status_id_str ? "回复" : "推文",
          views: num(t.views?.count),
          likes: num(t.legacy.favorite_count),
          comments: num(t.legacy.reply_count),
          shares: (num(t.legacy.retweet_count) || 0) + (num(t.legacy.quote_count) || 0),
          saves: num(t.legacy.bookmark_count),
        });
        return true;
      });
    }
  }
  return { account, posts: dedupe(posts) };
}

/* ---------- YouTube (Studio internal API) ---------- */

const YT_PRIVACY: Record<string, string> = { PUBLIC: "公开", UNLISTED: "不公开", PRIVATE: "私享", DRAFT: "草稿" };

export function parseYouTube(channelsJson: any, videosJson: any, channelId: string): CollectResult {
  const ch =
    (channelsJson?.channels || []).find((c: { channelId?: string }) => c.channelId === channelId) ||
    channelsJson?.channels?.[0];
  const m = ch?.metric || {};
  const account: AccountStats = {
    name: ch?.title,
    url: `https://www.youtube.com/channel/${channelId}`,
    followers: num(m.subscriberCount),
    posts: num(m.videoCount),
    views: num(m.totalVideoViewCount),
  };
  const posts: PostStats[] = (videosJson?.videos || []).map((v: any) => {
    const vm = v.metrics || {};
    const published = num(v.timePublishedSeconds);
    return {
      id: String(v.videoId),
      title: clip(v.title) || "(无标题)",
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
      publishedAt: published ? published * 1000 : undefined,
      type: YT_PRIVACY[String(v.privacy || "").replace("VIDEO_PRIVACY_", "")] || "视频",
      views: num(vm.viewCount) ?? num(vm.externalViewCount),
      likes: num(vm.likeCount),
      comments: num(vm.commentCount),
    };
  });
  return { account, posts: dedupe(posts.filter((p) => p.id && p.id !== "undefined")) };
}

/* ---------- TikTok ---------- */

export function parseTikTok(userInfo: any, itemBodies: string[], username: string): CollectResult {
  const st = userInfo?.stats || {};
  const st2 = userInfo?.statsV2 || {};
  const account: AccountStats = {
    name: userInfo?.user?.nickname,
    handle: userInfo?.user?.uniqueId || username,
    avatar: userInfo?.user?.avatarThumb,
    url: `https://www.tiktok.com/@${userInfo?.user?.uniqueId || username}`,
    followers: num(st2.followerCount) ?? num(st.followerCount),
    following: num(st2.followingCount) ?? num(st.followingCount),
    likes: num(st2.heartCount) ?? num(st.heartCount) ?? num(st.heart),
    posts: num(st2.videoCount) ?? num(st.videoCount),
  };
  const handle = account.handle || username;
  const posts: PostStats[] = [];
  for (const body of itemBodies) {
    for (const j of parseLoose(body)) {
      // 主页接口：itemList[].stats
      for (const it of j?.itemList || []) {
        const s = { ...(it.stats || {}), ...(it.statsV2 || {}) };
        posts.push({
          id: String(it.id),
          title: clip(it.desc) || "(无文字)",
          url: `https://www.tiktok.com/@${handle}/video/${it.id}`,
          publishedAt: num(it.createTime) ? (num(it.createTime) as number) * 1000 : undefined,
          type: it.imagePost ? "图文" : "视频",
          views: num(s.playCount),
          likes: num(s.diggCount),
          comments: num(s.commentCount),
          shares: num(s.shareCount),
          saves: num(s.collectCount),
        });
      }
      // TikTok Studio 接口：item_list[]（字段名不固定，按常见写法兜底）
      for (const it of j?.item_list || j?.items || []) {
        const id = it.item_id || it.id || it.aweme_id;
        if (!id) continue;
        const s = it.statistics || it.stats || it;
        posts.push({
          id: String(id),
          title: clip(it.desc || it.title || it.description) || "(无文字)",
          url: `https://www.tiktok.com/@${handle}/video/${id}`,
          publishedAt: num(it.create_time) ? (num(it.create_time) as number) * 1000 : undefined,
          type: "视频",
          views: num(s.play_count) ?? num(s.playCount) ?? num(s.view_count),
          likes: num(s.digg_count) ?? num(s.like_count) ?? num(s.diggCount),
          comments: num(s.comment_count) ?? num(s.commentCount),
          shares: num(s.share_count) ?? num(s.shareCount),
          saves: num(s.collect_count) ?? num(s.favorite_count) ?? num(s.collectCount),
        });
      }
    }
  }
  return { account, posts: dedupe(posts) };
}

/* ---------- 小红书（创作者中心） ---------- */

const XHS_SUMMARY: [string, string][] = [
  ["impl_count", "曝光"],
  ["view_count", "观看"],
  ["like_count", "点赞"],
  ["collect_count", "收藏"],
  ["comment_count", "评论"],
  ["share_count", "分享"],
  ["net_rise_fans_count", "净涨粉"],
];

export function parseXhs(personalBodies: string[], baseBodies: string[], postedBodies: string[]): CollectResult {
  const account: AccountStats = { url: "https://creator.xiaohongshu.com/new/home" };
  for (const body of personalBodies) {
    for (const j of parseLoose(body)) {
      const d = j?.data;
      if (!d || d.fans_count === undefined) continue;
      account.name = d.name;
      account.avatar = d.avatar;
      account.handle = d.red_num ? String(d.red_num) : account.handle;
      account.followers = num(d.fans_count);
      account.following = num(d.follow_count);
      account.likes = num(d.faved_count);
    }
  }
  const summary: SummaryItem[] = [];
  for (const body of baseBodies) {
    for (const j of parseLoose(body)) {
      const seven = j?.data?.seven;
      if (!seven) continue;
      summary.length = 0;
      for (const [k, label] of XHS_SUMMARY) {
        const v = num(seven[k]);
        if (v !== undefined) summary.push({ label, value: v });
      }
    }
  }
  const posts: PostStats[] = [];
  for (const body of postedBodies) {
    for (const j of parseLoose(body)) {
      for (const n of j?.data?.notes || []) {
        if (!n?.id) continue;
        const t = Date.parse(`${String(n.time || "").replace(" ", "T")}:00+08:00`);
        const token = n.xsec_token ? `?xsec_token=${encodeURIComponent(n.xsec_token)}&xsec_source=pc_creatormng` : "";
        posts.push({
          id: String(n.id),
          title: clip(n.display_title || n.title) || "(无标题)",
          url: `https://www.xiaohongshu.com/explore/${n.id}${token}`,
          publishedAt: Number.isFinite(t)
            ? t
            : num(n.visible_time)
              ? (num(n.visible_time) as number) * 1000
              : undefined,
          type: n.type === "video" ? "视频" : "图文",
          views: num(n.view_count),
          likes: num(n.likes),
          comments: num(n.comments_count),
          shares: num(n.shared_count),
          saves: num(n.collected_count),
        });
      }
    }
  }
  return { account, posts: dedupe(posts), summary, summaryLabel: "近 7 天" };
}

/* ---------- Threads（成效分析） ---------- */

function pickAll(v: unknown): number | undefined {
  if (Array.isArray(v)) {
    const all = (v as any[]).find((x) => x?.label === "ALL") ?? v[0];
    return num(all?.value);
  }
  if (v && typeof v === "object") return num((v as any).value);
  return num(v);
}

export function parseThreads(acctBodies: string[], postBodies: string[], handle: string): CollectResult {
  const account: AccountStats = { handle, url: handle ? `https://www.threads.com/@${handle}` : undefined };
  const summary: SummaryItem[] = [];
  for (const body of acctBodies) {
    for (const j of parseLoose(body)) {
      walk(j, (node) => {
        const d = node.text_app_account_insights?.data;
        if (!d) return;
        const tf = d.follower_trends?.total_followers;
        if (Array.isArray(tf) && tf.length) account.followers = num(tf[tf.length - 1]?.value) ?? account.followers;
        const es = d.engagement_summary;
        if (es) {
          summary.length = 0;
          const views = pickAll(es.views);
          const reach = pickAll(es.reach);
          const inter = pickAll(es.interactions);
          const net = pickAll(es.net_followers);
          if (views !== undefined) summary.push({ label: "浏览", value: views });
          if (reach !== undefined) summary.push({ label: "触达", value: reach });
          if (inter !== undefined) summary.push({ label: "互动", value: inter });
          if (net !== undefined) summary.push({ label: "净增粉丝", value: net });
          if (views !== undefined) account.views = views;
        }
        return true;
      });
    }
  }
  const posts: PostStats[] = [];
  for (const body of postBodies) {
    for (const j of parseLoose(body)) {
      walk(j, (node) => {
        if (node.__typename !== "XDTTextAppContentInsightsPostsNode" || !node.post) return;
        const p = node.post;
        const info = p.text_post_app_info || {};
        const taken = num(p.taken_at);
        posts.push({
          id: String(p.pk || p.id),
          title: clip(p.caption?.text) || "(无文字)",
          url: handle && p.code ? `https://www.threads.com/@${handle}/post/${p.code}` : undefined,
          publishedAt: taken ? taken * 1000 : undefined,
          type: "帖子",
          views: num(info.impression_count),
          likes: num(p.like_count),
          comments: num(info.direct_reply_count),
          shares: (num(info.repost_count) || 0) + (num(info.quote_count) || 0),
        });
        return true;
      });
    }
  }
  return { account, posts: dedupe(posts), summary, summaryLabel: "成效分析" };
}
