/**
 * Jeet的社媒工具 — built-in publishing console (Jeet fork of MultiPost).
 *
 * One editor -> X / TikTok / YouTube. Runs as an extension page, so it talks to the
 * background directly (no website trust step) and hands local files to the platform
 * tabs as blob: URLs (no data-URL size limit). Keep this page open while publishing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { refreshAccountInfo } from "~sync/account";
import type { AccountInfo, DynamicData, FileData, SyncData, VideoData } from "~sync/common";

/* ---------- constants ---------- */
const STORE = {
  drafts: "jeet_console_drafts",
  history: "jeet_console_history",
  current: "jeet_console_current",
  settings: "jeet_console_settings",
};
const LIMITS = { title: 100, x: 280, tiktok: 2200, youtube: 5000, maxImages: 4, imageMB: 5 };
const ACCOUNT_STORAGE_KEY = "multipost_account_info";

type PlatformKey = "x" | "tiktok" | "youtube";
const PLATFORMS: { key: PlatformKey; label: string; syncName: string }[] = [
  { key: "tiktok", label: "TikTok", syncName: "VIDEO_TIKTOK" },
  { key: "youtube", label: "YouTube", syncName: "VIDEO_YOUTUBE" },
  { key: "x", label: "X", syncName: "DYNAMIC_X" },
];

type XMedia = "video" | "images" | "none";
type VideoSource = "file" | "url";

interface FormState {
  platforms: Record<PlatformKey, boolean>;
  title: string;
  content: string;
  tagsRaw: string;
  videoSource: VideoSource;
  videoUrl: string;
  xMedia: XMedia;
}

interface Draft {
  id: string;
  savedAt: number;
  form: FormState;
  localVideo?: string;
  imageCount?: number;
}

interface StepResult {
  label: string;
  ok: boolean;
  message: string;
}

interface HistoryItem {
  id: string;
  at: number;
  auto: boolean;
  platforms: string[];
  form: FormState;
  video: string;
  results: StepResult[];
}

interface LocalMedia {
  file: File;
  previewUrl: string;
}

const EMPTY_FORM: FormState = {
  platforms: { x: true, tiktok: true, youtube: true },
  title: "",
  content: "",
  tagsRaw: "",
  videoSource: "file",
  videoUrl: "",
  xMedia: "video",
};

/* ---------- helpers ---------- */
function load<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : def;
  } catch {
    return def;
  }
}
function save(key: string, val: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (e) {
    console.error("localStorage 写入失败", e);
    return false;
  }
}
const uid = () => crypto.randomUUID();
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseTags(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let t of s.split(/[\s,，、;；]+/)) {
    t = t.replace(/^#+/, "").trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}
const hashTags = (tags: string[]) => tags.map((t) => `#${t}`).join(" ");

// Approximation of X's weighted length: URLs = 23, Latin = 1, CJK / emoji = 2.
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
function xLength(text: string): number {
  let n = 0;
  const rest = text.replace(/https?:\/\/[^\s]+/g, () => {
    n += 23;
    return "";
  });
  const graphemes = segmenter ? Array.from(segmenter.segment(rest), (s) => s.segment) : Array.from(rest);
  for (const g of graphemes) {
    if (/\p{Extended_Pictographic}/u.test(g)) {
      n += 2;
      continue;
    }
    const cp = g.codePointAt(0) ?? 0;
    const light =
      cp <= 0x10ff ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}
const charLen = (s: string) => Array.from(s).length;

function guessVideoType(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
  };
  return map[ext] || "video/mp4";
}

function sendToBackground<T>(action: string, data: unknown, timeout: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    chrome.runtime.sendMessage({ action, data }, (response: T) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

/* ---------- component ---------- */
const Console = () => {
  const [form, setForm] = useState<FormState>(() => ({ ...EMPTY_FORM, ...load(STORE.current, {}) }));
  const [autoPublish, setAutoPublish] = useState(false);
  const [video, setVideo] = useState<LocalMedia | null>(null);
  const [images, setImages] = useState<LocalMedia[]>([]);
  const [accounts, setAccounts] = useState<Partial<Record<PlatformKey, AccountInfo | null>>>({});
  const [acctNote, setAcctNote] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>(() => load(STORE.drafts, []));
  const [history, setHistory] = useState<HistoryItem[]>(() => load(STORE.history, []));
  const [interval, setIntervalSec] = useState<number>(() => load(STORE.settings, { interval: 5 }).interval || 5);
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState("");
  const blobUrls = useRef<string[]>([]);

  useEffect(() => {
    document.title = "Jeet的社媒工具";
  }, []);

  // persist editor
  useEffect(() => {
    save(STORE.current, form);
  }, [form]);
  useEffect(() => {
    save(STORE.settings, { interval });
  }, [interval]);

  // warn before closing while publishing (platform tabs still read the files from this page)
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (publishing) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [publishing]);

  /* ----- accounts ----- */
  const loadStoredAccounts = useCallback(async () => {
    const res = await chrome.storage.local.get(ACCOUNT_STORAGE_KEY);
    let map: Record<string, AccountInfo> = {};
    const raw = res[ACCOUNT_STORAGE_KEY];
    try {
      map = typeof raw === "string" ? JSON.parse(raw) : raw || {};
    } catch {
      map = {};
    }
    setAccounts({ x: map.x ?? null, tiktok: map.tiktok ?? null, youtube: map.youtube ?? null });
  }, []);

  const refreshAccounts = useCallback(async () => {
    setRefreshing(true);
    setAcctNote("正在检查各平台登录状态…");
    const errors: string[] = [];
    const next: Partial<Record<PlatformKey, AccountInfo | null>> = {};
    await Promise.all(
      PLATFORMS.map(async (p) => {
        try {
          next[p.key] = await refreshAccountInfo(p.key);
        } catch (e) {
          next[p.key] = null;
          errors.push(`${p.label}: ${(e as Error).message}`);
        }
      }),
    );
    setAccounts(next);
    setRefreshing(false);
    setAcctNote(errors.length ? `读取出错：${errors.join("；")}` : `更新于 ${new Date().toLocaleTimeString()}`);
  }, []);

  useEffect(() => {
    loadStoredAccounts().then(refreshAccounts);
  }, [loadStoredAccounts, refreshAccounts]);

  /* ----- media ----- */
  const onVideoFile = (f: File | undefined) => {
    if (video) URL.revokeObjectURL(video.previewUrl);
    setVideo(f ? { file: f, previewUrl: URL.createObjectURL(f) } : null);
  };
  const onImageFiles = (files: FileList | null) => {
    if (!files) return;
    const room = LIMITS.maxImages - images.length;
    const added = Array.from(files)
      .slice(0, Math.max(0, room))
      .map((file) => ({ file, previewUrl: URL.createObjectURL(file) }));
    setImages([...images, ...added]);
  };
  const removeImage = (i: number) => {
    URL.revokeObjectURL(images[i].previewUrl);
    setImages(images.filter((_, idx) => idx !== i));
  };
  const clearMedia = () => {
    if (video) URL.revokeObjectURL(video.previewUrl);
    for (const im of images) URL.revokeObjectURL(im.previewUrl);
    setVideo(null);
    setImages([]);
  };

  /* ----- validation ----- */
  const tags = useMemo(() => parseTags(form.tagsRaw), [form.tagsRaw]);
  const hasVideo = form.videoSource === "file" ? !!video : !!form.videoUrl.trim();
  const counts = useMemo(() => {
    const tagText = tags.length ? ` ${hashTags(tags)}` : "";
    return {
      title: charLen(form.title),
      x: xLength(form.content + tagText),
      tiktok: charLen(`${form.content}\n${hashTags(tags)}`),
      youtube: charLen(form.content + (tags.length ? `\n\n${hashTags(tags)}` : "")),
    };
  }, [form.title, form.content, tags]);

  const { errors, warns } = useMemo(() => {
    const e: string[] = [];
    const w: string[] = [];
    const p = form.platforms;
    const anyVideoPlatform = p.tiktok || p.youtube;
    if (!p.x && !p.tiktok && !p.youtube) e.push("请至少勾选一个平台。");
    if (anyVideoPlatform && !hasVideo) e.push("TikTok / YouTube 需要视频：请选择本地视频或填写 https 链接。");
    if (form.videoSource === "url" && form.videoUrl.trim() && !/^https:\/\//i.test(form.videoUrl.trim()))
      e.push("视频链接必须以 https:// 开头。");
    if (p.youtube) {
      if (!form.title.trim()) e.push("YouTube 需要标题。");
      if (counts.title > LIMITS.title) e.push(`YouTube 标题超过 ${LIMITS.title} 字。`);
      if (/[<>]/.test(form.title)) w.push("YouTube 标题里不能有 < 或 >。");
      if (counts.youtube > LIMITS.youtube) e.push(`YouTube 说明（含标签）超过 ${LIMITS.youtube} 字。`);
    }
    if (p.tiktok && counts.tiktok > LIMITS.tiktok) e.push(`TikTok 说明（含标签）超过 ${LIMITS.tiktok} 字。`);
    if (p.x) {
      if (counts.x > LIMITS.x) e.push(`X 正文（含标签）约 ${counts.x} 字，超过 ${LIMITS.x}。`);
      if (form.xMedia === "images" && !images.length) e.push("X 选了“只发图片”，请至少选 1 张图。");
      if (form.xMedia === "none" && !form.content.trim()) e.push("X 纯文字推文的正文不能为空。");
      if (form.xMedia === "video" && !hasVideo) {
        if (!form.content.trim()) e.push("X 选了“用同一个视频”，但还没有视频，正文也为空。");
        else w.push("X 还没有视频，将只发文字。");
      }
      const big = images.filter((im) => im.file.size > LIMITS.imageMB * 1024 * 1024).length;
      if (form.xMedia === "images" && big) w.push(`${big} 张图片超过 ${LIMITS.imageMB}MB，X 可能会拒绝。`);
    }
    if (!form.content.trim() && (p.x || p.tiktok || p.youtube)) w.push("正文为空。");
    if (/#\S/.test(form.content) && tags.length) w.push("正文里已有 # 标签，又填了标签栏，可能会重复。");
    return { errors: e, warns: w };
  }, [form, counts, hasVideo, images]);

  /* ----- publish ----- */
  const toBlobFile = async (): Promise<FileData | null> => {
    if (form.videoSource === "file") {
      if (!video) return null;
      const url = URL.createObjectURL(video.file);
      blobUrls.current.push(url);
      return {
        name: video.file.name,
        url,
        type: video.file.type || guessVideoType(video.file.name),
        size: video.file.size,
      };
    }
    const src = form.videoUrl.trim();
    if (!src) return null;
    setProgress("正在下载视频链接…");
    const res = await fetch(src);
    if (!res.ok) throw new Error(`视频链接下载失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    let name = "video.mp4";
    try {
      name = decodeURIComponent(new URL(src).pathname.split("/").filter(Boolean).pop() || name);
    } catch {
      /* keep default */
    }
    const url = URL.createObjectURL(blob);
    blobUrls.current.push(url);
    return { name, url, type: blob.type || guessVideoType(name), size: blob.size };
  };

  const publish = async () => {
    if (errors.length || publishing) return;
    if (autoPublish && !window.confirm("已开启“自动发布”，内容会直接发出去，确定继续？")) return;

    setPublishing(true);
    const results: StepResult[] = [];
    let videoFile: FileData | null = null;
    try {
      videoFile = await toBlobFile();
    } catch (e) {
      results.push({ label: "视频", ok: false, message: (e as Error).message });
    }

    const steps: { label: string; sync: SyncData }[] = [];
    if (results.length === 0) {
      if (form.platforms.tiktok && videoFile) {
        const data: VideoData = { title: "", content: form.content, video: videoFile, tags };
        steps.push({
          label: "TikTok",
          sync: { platforms: [{ name: "VIDEO_TIKTOK" }], isAutoPublish: autoPublish, data },
        });
      }
      if (form.platforms.youtube && videoFile) {
        // Tags go to the description so the title stays within 100 characters.
        const data: VideoData = {
          title: form.title.trim(),
          content: form.content + (tags.length ? `\n\n${hashTags(tags)}` : ""),
          video: videoFile,
          tags: [],
        };
        steps.push({
          label: "YouTube",
          sync: { platforms: [{ name: "VIDEO_YOUTUBE" }], isAutoPublish: autoPublish, data },
        });
      }
      if (form.platforms.x) {
        const imageFiles: FileData[] =
          form.xMedia === "images"
            ? images.map((im) => {
                const url = URL.createObjectURL(im.file);
                blobUrls.current.push(url);
                return { name: im.file.name, url, type: im.file.type || "image/jpeg", size: im.file.size };
              })
            : [];
        const data: DynamicData = {
          title: "", // X would prepend the title to the tweet
          content: form.content,
          images: imageFiles,
          videos: form.xMedia === "video" && videoFile ? [videoFile] : [],
          tags,
        };
        steps.push({ label: "X", sync: { platforms: [{ name: "DYNAMIC_X" }], isAutoPublish: autoPublish, data } });
      }
    }

    for (let i = 0; i < steps.length; i++) {
      if (i > 0) {
        for (let s = interval; s > 0; s--) {
          setProgress(`等待 ${s} 秒后打开 ${steps[i].label}…`);
          await sleep(1000);
        }
      }
      setProgress(`正在打开 ${steps[i].label}（${i + 1}/${steps.length}）…`);
      const r = await sendToBackground<{ tabs?: unknown[] }>("MULTIPOST_EXTENSION_PUBLISH_NOW", steps[i].sync, 180000);
      results.push(
        r?.tabs
          ? { label: steps[i].label, ok: true, message: "已打开并开始填写" }
          : { label: steps[i].label, ok: false, message: "没有收到插件响应（超时或打开页面失败）" },
      );
    }

    const allOk = results.length > 0 && results.every((r) => r.ok);
    setProgress(
      allOk
        ? autoPublish
          ? "已全部交给各平台自动发布。请保持本页打开几分钟，等视频上传完，再到各标签页确认结果。"
          : "已全部填好。请到各平台标签页检查内容后手动点发布；视频上传完之前不要关闭本页。"
        : "有步骤失败，详见下方发布记录。",
    );

    const item: HistoryItem = {
      id: uid(),
      at: Date.now(),
      auto: autoPublish,
      platforms: PLATFORMS.filter((p) => form.platforms[p.key]).map((p) => p.label),
      form,
      video: form.videoSource === "file" ? (video ? `本地文件 ${video.file.name}` : "") : form.videoUrl,
      results,
    };
    const nextHistory = [item, ...history].slice(0, 200);
    setHistory(nextHistory);
    save(STORE.history, nextHistory);
    setPublishing(false);
  };

  /* ----- drafts / history ----- */
  const saveDraft = () => {
    if (!form.title.trim() && !form.content.trim() && !form.tagsRaw.trim()) {
      window.alert("编辑器是空的。");
      return;
    }
    const d: Draft = {
      id: uid(),
      savedAt: Date.now(),
      form,
      localVideo: form.videoSource === "file" && video ? video.file.name : "",
      imageCount: images.length,
    };
    const next = [d, ...drafts].slice(0, 100);
    setDrafts(next);
    save(STORE.drafts, next);
  };
  const confirmOverwrite = () => !(form.title || form.content) || window.confirm("会覆盖当前编辑器里的内容，继续？");
  const loadDraft = (d: Draft) => {
    if (!confirmOverwrite()) return;
    clearMedia();
    setForm({ ...EMPTY_FORM, ...d.form });
    setAutoPublish(false);
    if (d.localVideo || d.imageCount) window.alert("这条草稿原来带有本地视频/图片，请重新选择文件。");
  };
  const deleteDraft = (id: string) => {
    if (!window.confirm("删除这条草稿？")) return;
    const next = drafts.filter((d) => d.id !== id);
    setDrafts(next);
    save(STORE.drafts, next);
  };
  const reuse = (h: HistoryItem) => {
    if (!confirmOverwrite()) return;
    clearMedia();
    setForm({ ...EMPTY_FORM, ...h.form });
    setAutoPublish(false);
  };
  const clearHistory = () => {
    if (!window.confirm("清空全部发布记录？")) return;
    setHistory([]);
    save(STORE.history, []);
  };
  const resetEditor = () => {
    if (!window.confirm("清空标题、正文、标签和媒体？")) return;
    clearMedia();
    setForm(EMPTY_FORM);
    setAutoPublish(false);
    setProgress("");
  };

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const acctName = (a?: AccountInfo | null) => (a ? a.username || a.accountId : "");

  /* ----- render ----- */
  return (
    <div className="jc">
      <style>{CSS}</style>
      <header>
        <img src={chrome.runtime.getURL(chrome.runtime.getManifest().icons?.["128"] ?? "")} alt="" />
        <h1>Jeet的社媒工具</h1>
        <span className="sub">X · TikTok · YouTube</span>
      </header>

      <main>
        <section>
          <div className="card">
            <h2>发布编辑器</h2>

            <div className="label">发布平台</div>
            <div className="platforms">
              {PLATFORMS.map((p) => (
                <label key={p.key} className={`pf ${form.platforms[p.key] ? "on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={form.platforms[p.key]}
                    onChange={(e) => set("platforms", { ...form.platforms, [p.key]: e.target.checked })}
                  />
                  {p.label}
                  <span className="acct">
                    {accounts[p.key] ? `@${acctName(accounts[p.key])}` : refreshing ? "…" : "未登录"}
                  </span>
                </label>
              ))}
            </div>

            <div className="label">
              标题 <small>仅 YouTube 使用，最多 100 字；不会发到 X 和 TikTok</small>
            </div>
            <input
              type="text"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="YouTube 视频标题"
            />
            <div className="counters">
              <span className={`${counts.title > LIMITS.title ? "over" : ""} ${form.platforms.youtube ? "" : "off"}`}>
                YouTube 标题 {counts.title}/{LIMITS.title}
              </span>
            </div>

            <div className="label">正文 / 说明</div>
            <textarea
              value={form.content}
              onChange={(e) => set("content", e.target.value)}
              placeholder="三个平台共用。TikTok、YouTube 作为视频说明，X 作为推文正文。"
            />

            <div className="label">
              话题标签 <small>空格或逗号分隔，不用加 #</small>
            </div>
            <input
              type="text"
              value={form.tagsRaw}
              onChange={(e) => set("tagsRaw", e.target.value)}
              placeholder="例如：Card2Dream giftcard Nigeria"
            />
            <div className="counters">
              <span className={`${counts.x > LIMITS.x ? "over" : ""} ${form.platforms.x ? "" : "off"}`}>
                X {counts.x}/{LIMITS.x}（含标签，按 X 规则估算）
              </span>
              <span className={`${counts.tiktok > LIMITS.tiktok ? "over" : ""} ${form.platforms.tiktok ? "" : "off"}`}>
                TikTok {counts.tiktok}/{LIMITS.tiktok}
              </span>
              <span
                className={`${counts.youtube > LIMITS.youtube ? "over" : ""} ${form.platforms.youtube ? "" : "off"}`}>
                YouTube 说明 {counts.youtube}/{LIMITS.youtube}（标签放在说明末尾）
              </span>
              <span>标签 {tags.length} 个</span>
            </div>

            <div className="label">
              视频 <small>TikTok、YouTube 必须有视频</small>
            </div>
            <div className="box">
              <div className="seg">
                {(["file", "url"] as VideoSource[]).map((v) => (
                  <label key={v} className={form.videoSource === v ? "on" : ""}>
                    <input type="radio" checked={form.videoSource === v} onChange={() => set("videoSource", v)} />
                    {v === "file" ? "本地视频" : "https 链接"}
                  </label>
                ))}
              </div>
              {form.videoSource === "file" ? (
                <div className="mt">
                  <input type="file" accept="video/*" onChange={(e) => onVideoFile(e.target.files?.[0])} />
                  {video && (
                    <>
                      <div className="hint">
                        已选择：{video.file.name}（{mb(video.file.size)}）{" "}
                        <button type="button" className="small" onClick={() => onVideoFile(undefined)}>
                          移除
                        </button>
                      </div>
                      <video className="preview" src={video.previewUrl} controls muted>
                        <track kind="captions" />
                      </video>
                    </>
                  )}
                </div>
              ) : (
                <div className="mt">
                  <input
                    type="text"
                    value={form.videoUrl}
                    onChange={(e) => set("videoUrl", e.target.value)}
                    placeholder="https://…/video.mp4（能直接下载的地址）"
                  />
                  <div className="hint">发布时插件会先把视频下载下来，再交给各平台。</div>
                </div>
              )}
            </div>

            <div className="label">X 配图方式</div>
            <div className="seg">
              {(
                [
                  ["video", "用同一个视频"],
                  ["images", "只发图片"],
                  ["none", "纯文字"],
                ] as [XMedia, string][]
              ).map(([v, l]) => (
                <label key={v} className={form.xMedia === v ? "on" : ""}>
                  <input type="radio" checked={form.xMedia === v} onChange={() => set("xMedia", v)} />
                  {l}
                </label>
              ))}
            </div>
            {form.xMedia === "images" && (
              <div className="box mt">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={images.length >= LIMITS.maxImages}
                  onChange={(e) => {
                    onImageFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <div className="hint">最多 {LIMITS.maxImages} 张。</div>
                <div className="thumbs">
                  {images.map((im, i) => (
                    <div className="thumb" key={im.previewUrl} title={`${im.file.name} ${mb(im.file.size)}`}>
                      <img src={im.previewUrl} alt="" />
                      <button type="button" onClick={() => removeImage(i)}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="label">发布模式</div>
            <label className={`switch ${autoPublish ? "on" : ""}`}>
              <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
              <div>
                <b>{autoPublish ? "自动发布" : "只填好不发布"}</b>
                <div className="hint">
                  {autoPublish
                    ? "填好后会直接点发布，发出去撤不回来，请确认内容无误。"
                    : "打开各平台发布页并填好内容，由人工检查后手动点发布。"}
                </div>
              </div>
            </label>

            <div className="msgs">
              {errors.map((m) => (
                <div key={m} className="e">
                  {m}
                </div>
              ))}
              {warns.map((m) => (
                <div key={m} className="w">
                  {m}
                </div>
              ))}
            </div>

            <div className="actions">
              <button type="button" className="primary" disabled={publishing || errors.length > 0} onClick={publish}>
                {publishing ? "发送中…" : autoPublish ? "开始自动发布" : "打开并填好"}
              </button>
              <button type="button" onClick={saveDraft}>
                存为草稿
              </button>
              <button type="button" className="danger" onClick={resetEditor}>
                清空
              </button>
              <span className="progress">{progress}</span>
            </div>
          </div>
        </section>

        <aside>
          <div className="card">
            <h2>
              账号
              <span className="grow" />
              <button type="button" className="small" disabled={refreshing} onClick={refreshAccounts}>
                {refreshing ? "刷新中" : "刷新"}
              </button>
            </h2>
            {PLATFORMS.map((p) => (
              <div className="acct-row" key={p.key}>
                <span className="name">{p.label}</span>
                <span className={accounts[p.key] ? "" : "none"}>
                  {accounts[p.key] ? acctName(accounts[p.key]) : "未登录"}
                </span>
              </div>
            ))}
            <div className="hint mt">{acctNote}</div>
            <div className="hint">未登录的话，在这个 Chrome 里打开对应网站登录后点“刷新”。</div>
          </div>

          <div className="card">
            <h2>
              草稿
              <span className="grow" />
              <span className="hint">{drafts.length ? `${drafts.length} 条` : ""}</span>
            </h2>
            <div className="list">
              {drafts.length === 0 && <div className="empty">还没有草稿</div>}
              {drafts.map((d) => (
                <div className="item" key={d.id}>
                  <div className="t">{(d.form.title || d.form.content || "(无标题)").slice(0, 60)}</div>
                  <div className="meta">
                    {new Date(d.savedAt).toLocaleString()}
                    {d.localVideo ? ` · 本地视频 ${d.localVideo}（需重选）` : ""}
                    {d.imageCount ? ` · ${d.imageCount} 张图（需重选）` : ""}
                  </div>
                  <div className="btns">
                    <button type="button" className="small" onClick={() => loadDraft(d)}>
                      载入
                    </button>
                    <button type="button" className="small danger" onClick={() => deleteDraft(d.id)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>
              发布记录
              <span className="grow" />
              <button type="button" className="small danger" onClick={clearHistory}>
                清空
              </button>
            </h2>
            <div className="list">
              {history.length === 0 && <div className="empty">还没有发布记录</div>}
              {history.map((h) => (
                <div className="item" key={h.id}>
                  <div className="t">{(h.form.title || h.form.content || "(无内容)").slice(0, 60)}</div>
                  <div className="meta">
                    {new Date(h.at).toLocaleString()} · {h.auto ? "自动发布" : "只填好"} · {h.platforms.join("/")}
                  </div>
                  <div className="res">
                    {h.results.map((r) => (
                      <span key={r.label} className={r.ok ? "ok" : "err"}>
                        {r.label} {r.ok ? "✓" : `✗ ${r.message}`}
                      </span>
                    ))}
                  </div>
                  <div className="btns">
                    <button type="button" className="small" onClick={() => reuse(h)}>
                      复用文案
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>设置</h2>
            <div className="label" style={{ marginTop: 0 }}>
              打开每个平台之间的间隔（秒）
            </div>
            <input
              type="number"
              min={3}
              max={60}
              value={interval}
              onChange={(e) => setIntervalSec(Math.max(3, Number(e.target.value) || 5))}
            />
          </div>

          <div className="foot">
            基于开源项目{" "}
            <a href="https://github.com/leaperone/MultiPost-Extension" target="_blank" rel="noreferrer">
              MultiPost
            </a>{" "}
            修改（Apache-2.0）
          </div>
        </aside>
      </main>
    </div>
  );
};

const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--line:#e3e6eb;--text:#1d2330;--muted:#6b7280;--brand:#6d3df5;--brand-soft:#f0ebff;--ok:#16a34a;--warn:#b45309;--warn-soft:#fff6e6;--err:#dc2626;--err-soft:#fdecec}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.jc header{display:flex;align-items:center;gap:10px;background:var(--card);border-bottom:1px solid var(--line);padding:10px 24px;position:sticky;top:0;z-index:5}
.jc header img{width:28px;height:28px;border-radius:7px}
.jc header h1{font-size:17px;margin:0}
.jc header .sub{color:var(--muted);font-size:13px}
.jc main{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:20px;padding:20px 24px;max-width:1360px;margin:0 auto}
@media (max-width:980px){.jc main{grid-template-columns:1fr}}
.jc .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}
.jc h2{font-size:15px;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.jc .grow{flex:1}
.jc .label{font-weight:600;margin:14px 0 6px}
.jc .label small{font-weight:400;color:var(--muted);margin-left:6px}
.jc input[type=text],.jc input[type=number],.jc textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff;color:inherit}
.jc textarea{min-height:150px;resize:vertical}
.jc input:focus,.jc textarea:focus{outline:2px solid var(--brand-soft);border-color:var(--brand)}
.jc button{font:inherit;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;color:var(--text)}
.jc button:disabled{opacity:.5;cursor:not-allowed}
.jc button.primary{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
.jc button.small{padding:2px 9px;font-size:12.5px}
.jc button.danger{color:var(--err)}
.jc .platforms{display:flex;gap:10px;flex-wrap:wrap}
.jc .pf{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer}
.jc .pf.on{border-color:var(--brand);background:var(--brand-soft)}
.jc .pf .acct{font-size:12px;color:var(--muted)}
.jc .counters{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:12.5px;color:var(--muted)}
.jc .counters .over{color:var(--err);font-weight:600}
.jc .counters .off{opacity:.45}
.jc .seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}
.jc .seg label{padding:5px 12px;cursor:pointer;border-right:1px solid var(--line);font-size:13px}
.jc .seg label:last-child{border-right:0}
.jc .seg label.on{background:var(--brand);color:#fff}
.jc .seg input{display:none}
.jc .box{border:1px dashed #c9ced8;border-radius:8px;padding:12px;background:#fafbfc}
.jc .mt{margin-top:10px}
.jc .hint{font-size:12.5px;color:var(--muted)}
.jc video.preview{max-width:100%;max-height:220px;border-radius:6px;margin-top:8px;background:#000}
.jc .thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.jc .thumb{position:relative;width:84px;height:84px;border-radius:6px;overflow:hidden;border:1px solid var(--line)}
.jc .thumb img{width:100%;height:100%;object-fit:cover}
.jc .thumb button{position:absolute;top:2px;right:2px;padding:0 6px;background:rgba(0,0,0,.6);color:#fff;border:0}
.jc .switch{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:8px;cursor:pointer}
.jc .switch.on{border-color:var(--warn);background:var(--warn-soft)}
.jc .msgs{margin-top:12px}
.jc .msgs div{padding:6px 10px;border-radius:6px;margin-bottom:6px;font-size:13px}
.jc .msgs .e{background:var(--err-soft);color:var(--err)}
.jc .msgs .w{background:var(--warn-soft);color:var(--warn)}
.jc .actions{display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap}
.jc .progress{font-size:13px;color:var(--brand);font-weight:600}
.jc .acct-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)}
.jc .acct-row:last-of-type{border-bottom:0}
.jc .acct-row .name{font-weight:600}
.jc .acct-row .none{color:var(--muted)}
.jc .list{max-height:300px;overflow:auto}
.jc .item{padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
.jc .item:last-child{border-bottom:0}
.jc .item .t{font-weight:600;word-break:break-all}
.jc .item .meta{color:var(--muted);font-size:12px}
.jc .item .btns{display:flex;gap:6px;margin-top:4px}
.jc .res{display:flex;gap:10px;flex-wrap:wrap;font-size:12.5px}
.jc .res .ok{color:var(--ok)} .jc .res .err{color:var(--err)}
.jc .empty{color:var(--muted);font-size:13px}
.jc .foot{font-size:12px;color:var(--muted);text-align:center}
.jc .foot a{color:var(--muted)}
`;

export default Console;
