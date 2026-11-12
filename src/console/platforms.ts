/**
 * Jeet fork: platform definitions and payload building, shared by the console page,
 * the scheduler and the AI inbox (background service worker).
 */

export interface PlatformDef {
  key: string;
  name: string;
  mp: string;
  account: string;
  color: string;
  kind: "dynamic" | "video";
  hasTitle: boolean;
  titleMax?: number;
  titleRequired?: boolean;
  max: number;
  weighted?: boolean;
  tagStyle: "xhs" | "plain";
  needImage?: boolean;
  needVideo?: boolean;
  maxImages?: number;
  allowVideo?: boolean;
  tagsInDesc?: boolean;
  /** MultiPost platform name for each post type this platform supports */
  mps: Partial<Record<PostType, string>>;
}

export type PostType = "text" | "image" | "video";
export const POST_TYPES: { key: PostType; name: string }[] = [
  { key: "text", name: "纯文字" },
  { key: "image", name: "图文" },
  { key: "video", name: "视频" },
];

export const PLATFORMS: PlatformDef[] = [
  {
    key: "xhs",
    mps: { image: "DYNAMIC_REDNOTE", video: "VIDEO_REDNOTE" },
    name: "小红书",
    mp: "DYNAMIC_REDNOTE",
    account: "rednote",
    color: "#ff2442",
    kind: "dynamic",
    hasTitle: true,
    titleMax: 20,
    titleRequired: true,
    max: 1000,
    tagStyle: "xhs",
    needImage: true,
    maxImages: 18,
    allowVideo: false,
  },
  {
    key: "threads",
    mps: { text: "DYNAMIC_THREADS", image: "DYNAMIC_THREADS", video: "DYNAMIC_THREADS" },
    name: "Threads",
    mp: "DYNAMIC_THREADS",
    account: "threads",
    color: "#111111",
    kind: "dynamic",
    hasTitle: false,
    max: 500,
    tagStyle: "plain",
    maxImages: 10,
    allowVideo: true,
  },
  {
    key: "x",
    mps: { text: "DYNAMIC_X", image: "DYNAMIC_X", video: "DYNAMIC_X" },
    name: "X",
    mp: "DYNAMIC_X",
    account: "x",
    color: "#111111",
    kind: "dynamic",
    hasTitle: false,
    max: 280,
    weighted: true,
    tagStyle: "plain",
    maxImages: 4,
    allowVideo: true,
  },
  {
    key: "tiktok",
    mps: { video: "VIDEO_TIKTOK" },
    name: "TikTok",
    mp: "VIDEO_TIKTOK",
    account: "tiktok",
    color: "#25f4ee",
    kind: "video",
    hasTitle: false,
    max: 2200,
    tagStyle: "plain",
    needVideo: true,
  },
  {
    key: "youtube",
    mps: { video: "VIDEO_YOUTUBE" },
    name: "YouTube",
    mp: "VIDEO_YOUTUBE",
    account: "youtube",
    color: "#ff0000",
    kind: "video",
    hasTitle: true,
    titleMax: 100,
    titleRequired: true,
    max: 5000,
    tagStyle: "plain",
    needVideo: true,
    tagsInDesc: true,
  },
];

export const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);
export const ALIASES: Record<string, string[]> = { xhs: ["rednote", "xiaohongshu"], youtube: ["yt"], tiktok: ["tt"] };

export interface Part {
  title: string;
  content: string;
  tags: string[];
}

export interface FileRef {
  name: string;
  url: string;
  type: string;
  size: number;
}

export function normTags(tags: unknown): string[] {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[\s,，#]+/);
  return arr
    .map((t) =>
      String(t)
        .trim()
        .replace(/^#+|#+$/g, ""),
    )
    .filter(Boolean);
}

export const hashTags = (tags: unknown, style = "plain") =>
  normTags(tags)
    .map((t) => (style === "xhs" ? `#${t}#` : `#${t}`))
    .join(" ");

// biome-ignore lint/suspicious/noExplicitAny: loose JSON input
export const toPart = (src: any): Part => ({
  title: src?.title || "",
  content: src?.content || src?.text || "",
  tags: normTags(src?.tags),
});

export const commonFor = (p: PlatformDef, c: Part): Part => ({
  title: p.hasTitle ? c.title || "" : "",
  content: c.content || "",
  tags: normTags(c.tags),
});

/** Per-platform copy from a raw draft: platform block, alias block, or the common block. */
// biome-ignore lint/suspicious/noExplicitAny: loose JSON input
export function partFor(p: PlatformDef, raw: any): Part {
  let src = raw[p.key];
  if (!src) for (const a of ALIASES[p.key] || []) if (raw[a]) src = raw[a];
  if (src) return toPart(src);
  if (raw.common) return commonFor(p, toPart(raw.common));
  return { title: "", content: "", tags: [] };
}

export interface MediaPlan {
  images: { name?: string; dataUrl: string; type?: string; size?: number }[];
  video: FileRef | { __video: true; name: string; type: string; size: number } | null;
}

/** The data part of SyncData for one platform. */
export function buildData(p: PlatformDef, part: Part, plan: MediaPlan) {
  const tags = normTags(part.tags);
  if (p.kind === "video") {
    return {
      title: p.hasTitle ? part.title.trim() : "", // TikTok 会把 title 拼进说明，所以留空
      // YouTube 会把 tags 拼进标题，容易超过 100 字，所以标签改放在说明末尾
      content: p.tagsInDesc && tags.length ? `${part.content}\n\n${hashTags(tags)}` : part.content,
      video: plan.video,
      tags: p.tagsInDesc ? [] : tags,
    };
  }
  return {
    title: p.hasTitle ? part.title : "", // X、Threads 会把 title 拼进正文，所以留空
    content: part.content,
    images: plan.images.map((im, k) => ({
      name: im.name || `image-${k + 1}.png`,
      url: im.dataUrl,
      type: im.type || "image/png",
      size: im.size || 0,
    })),
    videos: plan.video ? [plan.video] : [],
    tags,
  };
}

export function guessVideoType(name: string) {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  return (
    ({ mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" } as Record<string, string>)[
      ext
    ] || "video/mp4"
  );
}
export function guessImageType(name: string) {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  return (
    (
      { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<
        string,
        string
      >
    )[ext] || "image/jpeg"
  );
}
export function fileNameFromUrl(u: string, fallback: string) {
  try {
    return decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() || fallback);
  } catch {
    return fallback;
  }
}

export const supportsType = (p: PlatformDef, type: PostType) => !!p.mps[type];

/** Platform definition specialised for one post type (which MultiPost platform, which media). */
export function specFor(p: PlatformDef, type: PostType): PlatformDef {
  const mp = p.mps[type] || p.mp;
  const isVideoMp = mp.startsWith("VIDEO_");
  return {
    ...p,
    mp,
    kind: isVideoMp ? "video" : "dynamic",
    needImage: type === "image",
    needVideo: type === "video",
    allowVideo: false,
  };
}

export const typeLabel = (p: PlatformDef) =>
  POST_TYPES.filter((t) => p.mps[t.key])
    .map((t) => t.name)
    .join(" / ");
