/**
 * Jeet fork: Telegram publishing through the official Bot API.
 * The bot must be an admin (with "post messages") of each target channel / group.
 * Token and chat ids live only in this browser's settings.
 */

export interface TgConfig {
  token: string;
  /** "@channelname" or numeric ids like -1001234567890, comma / space separated */
  chats: string;
}

export const TG_CAPTION_MAX = 1024;
export const TG_TEXT_MAX = 4096;
export const TG_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const TG_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

interface FileLike {
  name?: string;
  url: string;
  type?: string;
}

interface TgData {
  content: string;
  tags?: string[];
  images?: FileLike[];
  videos?: FileLike[];
}

export const parseChats = (s: string) =>
  String(s || "")
    .split(/[\s,，;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Read the Telegram settings saved by the console (localStorage is shared by extension pages). */
export function tgConfigFromSettings(): TgConfig | null {
  try {
    const s = JSON.parse(localStorage.getItem("pub.settings.v1") || "{}");
    if (s?.tg?.token && parseChats(s.tg.chats).length) return s.tg;
  } catch {
    /* ignore */
  }
  return null;
}

async function call(token: string, method: string, body: FormData | Record<string, unknown>) {
  const isForm = body instanceof FormData;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
  });
  let json: { ok: boolean; description?: string; result?: unknown };
  try {
    json = await res.json();
  } catch {
    throw new Error(`Telegram 返回异常（HTTP ${res.status}）`);
  }
  if (!json.ok) throw new Error(json.description || `HTTP ${res.status}`);
  return json.result;
}

async function toBlob(f: FileLike) {
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`读取文件失败：${f.name || f.url}`);
  return res.blob();
}

export function tgText(data: TgData) {
  const tags = (data.tags || []).map((t) => `#${String(t).replace(/^#+/, "")}`).join(" ");
  return [data.content || "", tags].filter((x) => x.trim()).join("\n\n");
}

/** Send one post to every configured chat. Returns per-chat errors (empty = all ok). */
export async function sendTelegram(cfg: TgConfig, data: TgData): Promise<string[]> {
  const chats = parseChats(cfg.chats);
  if (!cfg.token || !chats.length) return ["没有设置 Telegram 机器人或频道"];
  const text = tgText(data);
  const images = data.images || [];
  const video = (data.videos || [])[0];

  // 先把文件读出来，多个频道共用
  const videoBlob = video ? await toBlob(video) : null;
  if (videoBlob && videoBlob.size > TG_VIDEO_MAX_BYTES) return ["视频超过 50MB，Telegram 机器人传不了"];
  const imageBlobs = await Promise.all(images.slice(0, 10).map(toBlob));

  const hasMedia = !!videoBlob || imageBlobs.length > 0;
  const captionFits = [...text].length <= TG_CAPTION_MAX;
  const caption = hasMedia && captionFits ? text : "";

  const errors: string[] = [];
  for (const chat_id of chats) {
    try {
      if (videoBlob) {
        const fd = new FormData();
        fd.append("chat_id", chat_id);
        fd.append("video", videoBlob, video?.name || "video.mp4");
        fd.append("supports_streaming", "true");
        if (caption) fd.append("caption", caption);
        await call(cfg.token, "sendVideo", fd);
      } else if (imageBlobs.length === 1) {
        const fd = new FormData();
        fd.append("chat_id", chat_id);
        fd.append("photo", imageBlobs[0], images[0].name || "image.jpg");
        if (caption) fd.append("caption", caption);
        await call(cfg.token, "sendPhoto", fd);
      } else if (imageBlobs.length > 1) {
        const fd = new FormData();
        fd.append("chat_id", chat_id);
        const media = imageBlobs.map((b, i) => {
          fd.append(`p${i}`, b, images[i].name || `image-${i + 1}.jpg`);
          return { type: "photo", media: `attach://p${i}`, ...(i === 0 && caption ? { caption } : {}) };
        });
        fd.append("media", JSON.stringify(media));
        await call(cfg.token, "sendMediaGroup", fd);
      }
      // 纯文字，或者文字太长放不进图片/视频说明（1024 字）时，单独发一条文字
      if (text && (!hasMedia || !captionFits)) {
        await call(cfg.token, "sendMessage", { chat_id, text, disable_web_page_preview: false });
      }
    } catch (e) {
      errors.push(`${chat_id}：${(e as Error).message}`);
    }
  }
  return errors;
}

/** Bot name + chat titles, for the account bar and the "test" button. */
export async function tgInfo(cfg: TgConfig) {
  const me = (await call(cfg.token, "getMe", {})) as { username: string };
  const chats: string[] = [];
  for (const chat_id of parseChats(cfg.chats)) {
    try {
      const c = (await call(cfg.token, "getChat", { chat_id })) as { title?: string; username?: string };
      chats.push(c.title || (c.username ? `@${c.username}` : chat_id));
    } catch (e) {
      chats.push(`${chat_id}（${(e as Error).message}）`);
    }
  }
  return { bot: me.username, chats };
}
