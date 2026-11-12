/**
 * Jeet fork: scheduled publishing.
 *
 * - The console saves a job (ready-to-send SyncData per platform + the video Blob) into IndexedDB
 *   and creates a chrome.alarms alarm.
 * - When the alarm fires, the background opens tabs/scheduler-run.html#<jobId>.
 * - That page (an extension page, so it can make blob: URLs) runs the job with PUBLISH_NOW,
 *   records the result and shows a notification.
 */

export const DB_NAME = "publisher";
export const DB_VERSION = 3;
export const ALARM_PREFIX = "jeet-job-";
/** A job that fires this much later than planned (computer asleep, Chrome closed) is not published automatically. */
export const MISSED_MS = 30 * 60 * 1000;
const GAP_MS = 3000;

export type JobStatus = "pending" | "running" | "done" | "failed" | "missed" | "cancelled";

export interface JobStep {
  key: string;
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: SyncData with a video placeholder
  syncData: any;
}

export interface JobResult {
  name: string;
  ok: boolean;
  auto?: boolean;
  msg?: string;
}

export interface Job {
  id: string;
  at: number;
  createdAt: number;
  draftId: string;
  topic: string;
  space: string;
  auto: boolean;
  steps: JobStep[];
  video: { blob?: Blob; url?: string; name: string; type: string; size: number } | null;
  status: JobStatus;
  results?: JobResult[];
  note?: string;
  startedAt?: number;
  finishedAt?: number;
}

/* ---------- IndexedDB (shared with the console's image store) ---------- */
let dbPromise: Promise<IDBDatabase> | null = null;
export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
        if (!db.objectStoreNames.contains("jobs")) db.createObjectStore("jobs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("inbox")) db.createObjectStore("inbox", { keyPath: "id" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

export async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest | undefined,
) {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result as T);
    t.onerror = () => reject(t.error);
  });
}

export const getJob = (id: string) => tx<Job | undefined>("jobs", "readonly", (s) => s.get(id));
export const putJob = (job: Job) => tx<void>("jobs", "readwrite", (s) => s.put(job));
export const deleteJob = (id: string) => tx<void>("jobs", "readwrite", (s) => s.delete(id));
export const listJobs = async () => {
  const all = (await tx<Job[]>("jobs", "readonly", (s) => s.getAll())) || [];
  return all.sort((a, b) => b.at - a.at);
};

/* ---------- alarms ---------- */
export async function scheduleAlarm(job: Job) {
  await chrome.alarms.create(ALARM_PREFIX + job.id, { when: Math.max(job.at, Date.now() + 1000) });
}
export async function clearAlarm(id: string) {
  await chrome.alarms.clear(ALARM_PREFIX + id);
}

/** Background: make sure every pending job still has an alarm (e.g. after a browser restart). */
export async function resyncAlarms() {
  const jobs = await listJobs();
  for (const job of jobs) {
    if (job.status !== "pending") continue;
    const existing = await chrome.alarms.get(ALARM_PREFIX + job.id);
    if (!existing) await scheduleAlarm(job);
  }
}

/** Background: open the runner page for a job. */
export async function openRunner(id: string) {
  const url = chrome.runtime.getURL(`tabs/scheduler-run.html#${id}`);
  try {
    await chrome.tabs.create({ url, active: false });
  } catch {
    await chrome.windows.create({ url, focused: false });
  }
}

/* ---------- runner ---------- */
function notify(title: string, message: string) {
  try {
    const icon = chrome.runtime.getManifest().icons?.["128"];
    chrome.notifications?.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL(icon || ""),
      title,
      message,
    });
  } catch (e) {
    console.debug("notification failed", e);
  }
}

function sendToBackground<T>(action: string, data: unknown, timeout: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    chrome.runtime.sendMessage({ action, data }, (resp: T) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recordInConsole(job: Job, results: JobResult[]) {
  try {
    const history = JSON.parse(localStorage.getItem("pub.history.v1") || "[]");
    history.unshift({
      at: Date.now(),
      space: job.space,
      draftId: job.draftId,
      topic: `⏰ ${job.topic}`,
      results,
      video: job.video?.name || "",
    });
    localStorage.setItem("pub.history.v1", JSON.stringify(history.slice(0, 300)));
    const drafts = JSON.parse(localStorage.getItem("pub.drafts.v1") || "[]");
    const d = drafts.find((x: { id: string }) => x.id === job.draftId);
    if (d) {
      d.published = d.published || {};
      for (const step of job.steps) {
        if (results.find((r) => r.name === step.name && r.ok)) d.published[step.key] = Date.now();
      }
      localStorage.setItem("pub.drafts.v1", JSON.stringify(drafts));
    }
  } catch (e) {
    console.debug("record failed", e);
  }
}

export async function runJob(id: string, log: (msg: string) => void): Promise<Job | undefined> {
  const job = await getJob(id);
  if (!job) {
    log("找不到这个定时任务（可能已被取消）。");
    return undefined;
  }
  if (job.status !== "pending") {
    log(`任务状态是“${job.status}”，不重复执行。`);
    return job;
  }

  const late = Date.now() - job.at;
  if (late > MISSED_MS) {
    job.status = "missed";
    job.note = `晚了 ${Math.round(late / 60000)} 分钟才触发（电脑可能睡眠了或 Chrome 没开），为避免发错时间没有自动发布。`;
    job.finishedAt = Date.now();
    await putJob(job);
    log(job.note);
    notify("定时发布已错过", `「${job.topic}」没有发出，请在控制台的“定时任务”里选择立即发布。`);
    return job;
  }

  job.status = "running";
  job.startedAt = Date.now();
  await putJob(job);
  log(`开始执行「${job.topic}」：${job.steps.map((s) => s.name).join("、")}`);

  // biome-ignore lint/suspicious/noExplicitAny: FileData
  let videoFile: any = null;
  const results: JobResult[] = [];
  try {
    if (job.video?.blob) {
      videoFile = {
        name: job.video.name,
        type: job.video.type,
        size: job.video.size,
        url: URL.createObjectURL(job.video.blob),
      };
    } else if (job.video?.url) {
      log("正在下载视频链接…");
      const res = await fetch(job.video.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      videoFile = {
        name: job.video.name,
        type: blob.type || job.video.type,
        size: blob.size,
        url: URL.createObjectURL(blob),
      };
    }
  } catch (e) {
    const msg = `视频准备失败：${(e as Error).message}`;
    log(msg);
    for (const s of job.steps) results.push({ name: s.name, ok: false, msg });
  }

  // 远程图片/视频（AI 给的 https 链接）先在本页下载成 blob，避免平台页面跨域读不到
  const remote = new Map<string, string>();
  // biome-ignore lint/suspicious/noExplicitAny: FileData
  const localize = async (f: any) => {
    if (!f || f.__video || typeof f.url !== "string" || !/^https?:\/\//i.test(f.url)) return f;
    if (!remote.has(f.url)) {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）：${f.url}`);
      const blob = await res.blob();
      remote.set(f.url, URL.createObjectURL(blob));
      f.size = blob.size;
      if (blob.type) f.type = blob.type;
    }
    return { ...f, url: remote.get(f.url) };
  };

  if (!results.length) {
    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i];
      const syncData = structuredClone(step.syncData);
      const data = syncData.data;
      if (data.video?.__video) data.video = videoFile;
      if (Array.isArray(data.videos)) {
        data.videos = data.videos.map((v: any) => (v?.__video ? videoFile : v)).filter(Boolean);
      }
      if (data.video === null && step.syncData.data.video) {
        results.push({ name: step.name, ok: false, msg: "缺少视频" });
        continue;
      }
      try {
        if (Array.isArray(data.images)) data.images = await Promise.all(data.images.map(localize));
      } catch (e) {
        results.push({ name: step.name, ok: false, msg: (e as Error).message });
        log(`${step.name} 失败：${(e as Error).message}`);
        continue;
      }
      log(`正在打开 ${step.name}（${i + 1}/${job.steps.length}）…`);
      const r = await sendToBackground<{ tabs?: unknown[] }>("MULTIPOST_EXTENSION_PUBLISH_NOW", syncData, 180000);
      if (r?.tabs) {
        results.push({ name: step.name, ok: true, auto: !!syncData.isAutoPublish });
        log(`${step.name} 已打开并开始填写`);
      } else {
        results.push({ name: step.name, ok: false, msg: "打开发布页失败或超时" });
        log(`${step.name} 失败：打开发布页失败或超时`);
      }
      if (i < job.steps.length - 1) await sleep(GAP_MS);
    }
  }

  job.results = results;
  job.status = results.every((r) => r.ok) ? "done" : "failed";
  job.finishedAt = Date.now();
  await putJob(job);
  recordInConsole(job, results);

  const okNames = results.filter((r) => r.ok).map((r) => r.name);
  const badNames = results.filter((r) => !r.ok).map((r) => r.name);
  notify(
    job.status === "done" ? "定时发布已执行" : "定时发布有失败",
    `「${job.topic}」${okNames.length ? `已打开：${okNames.join("、")}` : ""}${badNames.length ? `；失败：${badNames.join("、")}` : ""}`,
  );
  log(job.status === "done" ? "全部完成。本页会保留 15 分钟，等视频上传完后自动关闭。" : "有平台失败，详见上方。");
  return job;
}
