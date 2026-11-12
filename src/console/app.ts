import { PLATFORMS, buildData } from "~console/platforms";
// @ts-nocheck
/**
 * Jeet fork: built-in publishing console logic.
 * Ported from the single-file web console; runs inside the extension page, talks to the
 * background directly (MULTIPOST_EXTENSION_PUBLISH_NOW) and hands files to platform tabs
 * as blob:/data: URLs.
 */
import { MISSED_MS, clearAlarm, deleteJob, getJob, listJobs, openDb, putJob, scheduleAlarm } from "~console/scheduler";
import { refreshAccountInfo } from "~sync/account";
import { setProbeAllowed } from "~sync/account/tab-probe";

let started = false;

export function initConsole(): void {
  if (started) return;
  started = true;

  ("use strict");

  /* ---------- 平台配置 ---------- */
  // kind: dynamic = 图文平台；video = 视频平台
  // 平台配置在 ~console/platforms，定时任务和 AI 收件箱共用
  const PMAP = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));
  const COLORS = ["#5b3df5", "#1f6f5c", "#d9480f", "#c2255c", "#1971c2", "#495057"];
  const PUBLISH_GAP_MS = 3000; // 每个平台单独打开，中间稍等一下
  const DEFAULT_DRAFTS_URL = "https://raw.githubusercontent.com/chetoufu-bit/jeet-social-tool/gh-pages/drafts.json";
  const LS_DRAFTS = "pub.drafts.v1";
  const LS_PREFS = "pub.prefs.v1";
  const LS_SETTINGS = "pub.settings.v1";
  const LS_HISTORY = "pub.history.v1";
  const ACCOUNT_STORAGE_KEY = "multipost_account_info";

  /* ---------- 小工具 ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const uid = () => "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mb = (b) => (b / 1024 / 1024).toFixed(1) + "MB";
  const fmtTime = (t) => {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2400);
  }
  function log(msg) {
    $("#log").textContent = `${fmtTime(Date.now())}  ${msg}`;
  }

  function lsGet(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  }
  function lsSet(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch (e) {
      toast("本地保存失败：" + e.message);
      return false;
    }
  }

  function normTags(tags) {
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
  function tagsToText(tags) {
    return normTags(tags).join(" ");
  }
  const hashTags = (tags, style) =>
    normTags(tags)
      .map((t) => (style === "xhs" ? `#${t}#` : `#${t}`))
      .join(" ");

  // X 的计数规则：中日韩文字、emoji 等算 2，链接一律算 23
  function xWeightedLength(text) {
    let s = String(text || "");
    let n = 0;
    s = s.replace(/https?:\/\/\S+/g, () => {
      n += 23;
      return "";
    });
    for (const ch of s) {
      const c = ch.codePointAt(0);
      const light = c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247);
      n += light ? 1 : 2;
    }
    return n;
  }
  function fullText(p, d) {
    const part = d[p.key] || {};
    const tagStr = hashTags(part.tags, p.tagStyle);
    if (!tagStr) return part.content || "";
    return (part.content || "") + (p.tagsInDesc ? "\n\n" : " ") + tagStr;
  }
  function countFor(p, d) {
    const text = fullText(p, d);
    return p.weighted ? xWeightedLength(text) : [...text].length;
  }

  /* ---------- 设置（每个浏览器各自一份） ---------- */
  // 默认 5 个平台全开；只用其中几个的话，可以在“平台设置”里关掉不用的
  let settings = lsGet(LS_SETTINGS, null) || { space: "", color: COLORS[0], enabled: PLATFORMS.map((p) => p.key) };
  const enabledPlatforms = () => PLATFORMS.filter((p) => settings.enabled.includes(p.key));

  function applySpace() {
    const name = settings.space || "";
    $("#spaceBadge").style.display = name ? "" : "none";
    $("#spaceName").textContent = name;
    $("#barSpace").parentElement.style.display = name ? "" : "none";
    $("#barSpace").textContent = name;
    document.documentElement.style.setProperty("--space", name ? settings.color || COLORS[0] : "transparent");
    document.title = name ? `${name} · 社媒发布控制台` : "社媒发布控制台";
  }

  /* ---------- 图片存储（IndexedDB，避免 localStorage 装不下） ---------- */
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = openDb());
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction("images", mode);
        const req = fn(t.objectStore("images"));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: (id) => tx("readonly", (s) => s.get(id)).then((v) => v || []),
      set: (id, v) => tx("readwrite", (s) => s.put(v, id)),
      del: (id) => tx("readwrite", (s) => s.delete(id)),
    };
  })();

  function readAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }

  /* ---------- 视频（只存在内存里，不进草稿） ---------- */
  // 本地视频按草稿 id 暂存在内存中，刷新页面后需要重新选择
  const localVideos = new Map(); // draftId -> {name,type,size,dataUrl,previewUrl}

  function guessVideoType(name) {
    const ext = (String(name).split(".").pop() || "").toLowerCase();
    return { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" }[ext] || "video/mp4";
  }
  // 返回发布时用的视频 FileData，没有则 null
  function currentVideo(d) {
    if (!d) return null;
    if ((d.videoSource || "file") === "url") {
      const u = (d.videoUrl || "").trim();
      if (!/^https:\/\//i.test(u)) return null;
      let name = "video.mp4";
      try {
        name = decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() || name);
      } catch {}
      return { name, url: u, type: guessVideoType(name), size: 0 };
    }
    const v = localVideos.get(d.id);
    return v ? { name: v.name, url: v.dataUrl, type: v.type, size: v.size } : null;
  }

  /* ---------- 和插件后台通信（控制台本身就是插件页面，不需要授权） ---------- */
  function bg(action, data, timeout) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      chrome.runtime.sendMessage({ action, data }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(resp);
      });
    });
  }

  const extState = "ready";
  let publishing = false;
  let accountInfo = {};
  let refreshingAccounts = false;

  function setStatus(text) {
    const el = $("#extStatus");
    el.className = "pill ok";
    el.lastElementChild.textContent = text;
  }

  async function readStoredAccounts() {
    const res = await chrome.storage.local.get(ACCOUNT_STORAGE_KEY);
    const raw = res[ACCOUNT_STORAGE_KEY];
    try {
      return (typeof raw === "string" ? JSON.parse(raw) : raw) || {};
    } catch {
      return {};
    }
  }

  async function loadAccounts() {
    accountInfo = await readStoredAccounts();
    renderAccounts();
    updateCardAccounts();
  }
  // quick = 打开控制台时的自动刷新：不打开后台标签页（小红书、Threads 保留上次手动刷新的结果）
  async function refreshAccounts(quick = false) {
    if (refreshingAccounts) return;
    refreshingAccounts = true;
    $("#btnRefreshAcc").textContent = "刷新中…";
    if (!quick) log("正在检查各平台登录状态（小红书、Threads 会短暂打开一个后台标签页）…");
    setProbeAllowed(!quick);
    const keys = [...new Set(enabledPlatforms().map((p) => p.account))];
    const failed = [];
    const withTimeout = (pr, ms) =>
      Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error("超时")), ms))]);
    await Promise.all(
      keys.map(async (k) => {
        try {
          await withTimeout(refreshAccountInfo(k), 40000);
        } catch (e) {
          if (e?.name === "ProbeSkippedError") return;
          failed.push(PLATFORMS.find((p) => p.account === k)?.name || k);
          console.debug("刷新账号失败", k, e);
        }
      }),
    );
    setProbeAllowed(true);
    refreshingAccounts = false;
    $("#btnRefreshAcc").textContent = "刷新账号";
    await loadAccounts();
    if (failed.length) log(`部分平台账号读取失败：${failed.join("、")}（不影响发布）`);
    else if (!quick) log("账号状态已更新");
  }
  function updateCardAccounts() {
    for (const p of enabledPlatforms()) {
      const el = $(`.card[data-p="${p.key}"] .acc`);
      if (el) {
        const n = accName(p);
        el.textContent = n ? "@" + n : "";
      }
    }
  }
  const accName = (p) => {
    const a = accountInfo[p.account];
    return a ? a.username || a.accountId : "";
  };

  function renderAccounts() {
    $("#accounts").innerHTML = enabledPlatforms()
      .map((p) => {
        const n = accName(p);
        return `<span class="pill ${n ? "ok" : ""}" title="${n ? "已登录" : "没读到登录信息：在这个 Chrome 里登录该平台后点“刷新账号”"}"><span class="dot"></span>${esc(p.name)}：${n ? esc(n) : "未识别"}</span>`;
      })
      .join("");
  }

  /* ---------- 草稿数据 ---------- */
  let drafts = lsGet(LS_DRAFTS, []);
  const prefs = lsGet(LS_PREFS, {});
  prefs.selected = { xhs: true, threads: true, x: true, tiktok: true, youtube: true, ...(prefs.selected || {}) };
  prefs.auto = { xhs: false, threads: false, x: false, tiktok: false, youtube: false, ...(prefs.auto || {}) };
  prefs.withImg = prefs.withImg || {};
  prefs.withVideo = prefs.withVideo || {};
  let currentId = drafts[0]?.id || null;
  let currentImages = [];

  const emptyPart = () => ({ title: "", content: "", tags: [] });
  function blankDraft() {
    const d = {
      id: uid(),
      topic: "未命名草稿",
      suggestedTime: "",
      imageNote: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      common: emptyPart(),
      videoSource: "file",
      videoUrl: "",
      published: {},
    };
    for (const p of PLATFORMS) d[p.key] = emptyPart();
    return d;
  }
  // 兼容旧草稿：补齐新平台和通用文案字段
  function upgradeDraft(d) {
    for (const p of PLATFORMS) if (!d[p.key]) d[p.key] = emptyPart();
    if (!d.common) d.common = emptyPart();
    if (!d.videoSource) d.videoSource = "file";
    if (d.videoUrl == null) d.videoUrl = "";
    if (!d.published) d.published = {};
    return d;
  }
  drafts = drafts.map(upgradeDraft);

  const ALIASES = { xhs: ["rednote", "xiaohongshu"], youtube: ["yt"], tiktok: ["tt"] };
  function normalizeDraft(raw) {
    const d = blankDraft();
    if (raw.id) d.id = String(raw.id);
    d.topic = raw.topic || raw.title || raw.common?.title || raw.xhs?.title || d.topic;
    d.suggestedTime = raw.suggestedTime || raw.time || "";
    d.imageNote = raw.imageNote || raw.image || "";
    const toPart = (src) => ({
      title: src?.title || "",
      content: src?.content || src?.text || "",
      tags: normTags(src?.tags),
    });
    if (raw.common) d.common = toPart(raw.common);
    for (const p of PLATFORMS) {
      let src = raw[p.key];
      if (!src)
        for (const a of ALIASES[p.key] || [])
          if (raw[a]) {
            src = raw[a];
            break;
          }
      if (src) d[p.key] = toPart(src);
      else if (raw.common) d[p.key] = commonFor(p, d.common); // 只给了通用文案时，自动铺到各平台
    }
    const vurl = raw.videoUrl || raw.video_url || raw.video;
    if (typeof vurl === "string" && /^https:\/\//i.test(vurl)) {
      d.videoSource = "url";
      d.videoUrl = vurl;
    }
    d.published = raw.published || {};
    return d;
  }
  const current = () => drafts.find((d) => d.id === currentId);
  function saveDrafts() {
    lsSet(LS_DRAFTS, drafts);
  }
  function savePrefs() {
    lsSet(LS_PREFS, prefs);
  }

  function mergeDrafts(list) {
    let added = 0,
      updated = 0;
    for (const raw of list) {
      const d = normalizeDraft(raw);
      const i = drafts.findIndex((x) => x.id === d.id);
      if (i >= 0) {
        d.published = drafts[i].published || {};
        d.createdAt = drafts[i].createdAt;
        if (!raw.videoUrl && !raw.video_url && !raw.video) {
          d.videoSource = drafts[i].videoSource;
          d.videoUrl = drafts[i].videoUrl;
        }
        drafts[i] = d;
        updated++;
      } else {
        drafts.unshift(d);
        added++;
      }
    }
    saveDrafts();
    return { added, updated };
  }
  function parseImport(text) {
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1];
    const obj = JSON.parse(s);
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj.drafts)) return obj.drafts;
    return [obj];
  }

  /* ---------- 通用文案 → 各平台 ---------- */
  function commonFor(p, c) {
    return { title: p.hasTitle ? c.title || "" : "", content: c.content || "", tags: normTags(c.tags) };
  }
  function syncCommonToAll(d, { silent = false } = {}) {
    for (const p of enabledPlatforms()) d[p.key] = commonFor(p, d.common);
    touch();
    if (!silent) {
      for (const p of enabledPlatforms()) {
        const card = $(`.card[data-p="${p.key}"]`);
        if (!card) continue;
        const part = d[p.key];
        card.querySelectorAll("[data-f]").forEach((inp) => {
          const f = inp.dataset.f;
          inp.value = f === "tags" ? tagsToText(part.tags) : part[f] || "";
        });
        updateCount(p);
      }
    }
  }

  /* ---------- 渲染 ---------- */
  function renderList() {
    const el = $("#draftList");
    if (!drafts.length) {
      el.innerHTML = `<div class="empty">还没有草稿<br>点“新建”或“导入草稿”</div>`;
      return;
    }
    el.innerHTML = drafts
      .map((d) => {
        const tags = enabledPlatforms()
          .map((p) => (d.published?.[p.key] ? `<span class="tag done">${p.name} ✓</span>` : ""))
          .join("");
        return `<div class="draft-item ${d.id === currentId ? "active" : ""}" data-id="${esc(d.id)}">
        <div class="t">${esc(d.topic)}</div>
        <div class="m">${d.suggestedTime ? `<span>${esc(d.suggestedTime)}</span>` : `<span>${fmtTime(d.updatedAt)}</span>`}${tags}</div>
      </div>`;
      })
      .join("");
  }

  function renderBanner() {
    const b = $("#banner");
    if (!b) return;
    if (publishing) {
      b.className = "banner warn";
      b.innerHTML = "正在发布：各平台标签页要从本页读取视频和图片，等它们开始上传后再关闭本页。";
    } else {
      b.className = "";
      b.innerHTML = "";
    }
  }

  const usesImages = () => enabledPlatforms().some((p) => p.kind === "dynamic");
  const usesVideo = () => enabledPlatforms().some((p) => p.needVideo || p.allowVideo);

  async function renderEditor() {
    const main = $("#main");
    const d = current();
    if (!d) {
      main.innerHTML = `<div id="banner"></div><div class="empty" style="padding-top:80px">选择左侧草稿，或新建一条</div>`;
      renderBanner();
      return;
    }
    currentImages = await idb.get(d.id);
    const plats = enabledPlatforms();
    const anyTitle = plats.some((p) => p.hasTitle);
    main.innerHTML = `
      <div id="banner"></div>
      <div class="topic-row">
        <div>
          <label class="small">主题（只在本页显示）</label>
          <input type="text" id="fTopic" value="${esc(d.topic)}">
        </div>
        <div>
          <label class="small">建议发布时间</label>
          <input type="text" id="fTime" value="${esc(d.suggestedTime)}" placeholder="例如：今晚 21:00">
        </div>
      </div>
      <div class="media-row">
        ${
          usesImages()
            ? `<div>
          <label class="small">配图（图文平台共用；小红书必须有图，X 只取前 4 张）${d.imageNote ? " · 配图建议：" + esc(d.imageNote) : ""}</label>
          <div class="images" id="images"></div>
        </div>`
            : ""
        }
        ${
          usesVideo()
            ? `<div>
          <label class="small">视频（TikTok、YouTube 必须有；X、Threads 可选带）</label>
          <div class="video-box">
            <div class="seg" id="vSrc">
              <label class="${d.videoSource !== "url" ? "on" : ""}"><input type="radio" name="vsrc" value="file">本地文件</label>
              <label class="${d.videoSource === "url" ? "on" : ""}"><input type="radio" name="vsrc" value="url">https 链接</label>
            </div>
            <div id="vBody"></div>
          </div>
        </div>`
            : ""
        }
      </div>
      <div class="common">
        <div class="common-h">
          <b>通用文案</b><span class="kind">各平台发同样内容时用</span>
          <div class="right">
            <label class="switch" title="勾选后，改通用文案会实时同步到各平台的文案框"><input type="checkbox" id="fLinked" ${prefs.linked ? "checked" : ""}>边改边同步</label>
            <button class="primary small" id="btnSyncAll">同步到所有平台</button>
          </div>
        </div>
        ${
          anyTitle
            ? `<label class="small">标题（会同步给需要标题的平台：${plats
                .filter((p) => p.hasTitle)
                .map((p) => `${p.name} ≤${p.titleMax} 字`)
                .join("、")}）</label>
        <input type="text" id="cTitle" value="${esc(d.common.title)}">`
            : ""
        }
        <label class="small">正文</label>
        <textarea id="cContent" style="min-height:120px">${esc(d.common.content)}</textarea>
        <label class="small">话题标签（空格分隔，不用写 #）</label>
        <input type="text" id="cTags" value="${esc(tagsToText(d.common.tags))}">
      </div>
      <div class="cards">${plats.map(cardHTML).join("") || `<div class="empty">这个浏览器还没选平台，点右上角“平台设置”</div>`}</div>
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="ghost" id="btnDelete">删除这条草稿</button>
      </div>`;
    renderBanner();
    renderImages();
    renderVideo();
    bindEditor();
    plats.forEach(updateCount);
  }

  function cardHTML(p) {
    const d = current();
    const part = d[p.key];
    const n = accName(p);
    const pub = d.published?.[p.key];
    const imgSwitch =
      p.kind === "dynamic" && !p.needImage
        ? `<label class="switch" title="是否把上面的配图一起发到这个平台"><input type="checkbox" data-img ${prefs.withImg[p.key] !== false ? "checked" : ""}>带图</label>`
        : "";
    const vidSwitch = p.allowVideo
      ? `<label class="switch" title="是否把上面的视频一起发到这个平台（带视频时不带图）"><input type="checkbox" data-vid ${prefs.withVideo[p.key] ? "checked" : ""}>带视频</label>`
      : "";
    return `<div class="card ${prefs.selected[p.key] ? "" : "off"}" data-p="${p.key}">
      <div class="card-h">
        <span class="badge" style="background:${p.color}"></span>
        <span class="name">${p.name}</span>
        <span class="kind">${p.kind === "video" ? "视频" : p.needImage ? "图文" : "动态"}</span>
        <span class="acc">${n ? "@" + esc(n) : ""}</span>
        <div class="right">
          ${imgSwitch}${vidSwitch}
          <label class="switch" title="不勾选时插件只填好内容，由你在平台页面上自己点发布"><input type="checkbox" data-auto ${prefs.auto[p.key] ? "checked" : ""}>自动发布</label>
          <label class="switch"><input type="checkbox" data-sel ${prefs.selected[p.key] ? "checked" : ""}>发布</label>
        </div>
      </div>
      ${
        p.hasTitle
          ? `<label class="small">标题（≤${p.titleMax} 字${p.titleRequired ? "，必填" : ""}）</label>
        <input type="text" data-f="title" value="${esc(part.title)}">
        <div class="count" data-tc></div>`
          : ""
      }
      <label class="small">${p.kind === "video" ? "说明" : "正文"}</label>
      <textarea data-f="content">${esc(part.content)}</textarea>
      <label class="small">话题标签（空格分隔，不用写 #）${p.tagsInDesc ? "· 会放在说明末尾" : ""}</label>
      <input type="text" data-f="tags" value="${esc(tagsToText(part.tags))}">
      <div class="count" data-c></div>
      <div class="hint" data-hint></div>
      <div class="card-f">
        <button data-copy>复制全文</button>
        <button data-fromcommon class="ghost" title="用通用文案覆盖这个平台的文案">用通用文案</button>
        <span class="st ${pub ? "done" : ""}">${pub ? "已打开并填写 " + fmtTime(pub) : "未发布"}</span>
      </div>
    </div>`;
  }

  function mediaPlan(p, d) {
    // 返回该平台实际会带的图片/视频
    const video = currentVideo(d);
    if (p.kind === "video") return { images: [], video };
    const wantVideo = p.allowVideo && prefs.withVideo[p.key] && video;
    if (wantVideo) return { images: [], video };
    const useImg = p.needImage || prefs.withImg[p.key] !== false;
    return { images: useImg ? currentImages.slice(0, p.maxImages) : [], video: null };
  }

  function updateCount(p) {
    const d = current();
    if (!d) return;
    const card = $(`.card[data-p="${p.key}"]`);
    if (!card) return;
    const n = countFor(p, d);
    const c = $("[data-c]", card);
    c.textContent = `${n} / ${p.max}${p.weighted ? "（中文按 2 计，含标签）" : "（含标签）"}`;
    c.classList.toggle("over", n > p.max);
    if (p.hasTitle) {
      const tn = [...(d[p.key].title || "")].length;
      const tc = $("[data-tc]", card);
      tc.textContent = `${tn} / ${p.titleMax}`;
      tc.classList.toggle("over", tn > p.titleMax);
    }
    const hint = [];
    const video = currentVideo(d);
    if (p.needImage && !currentImages.length) hint.push(`${p.name}图文笔记必须至少 1 张图`);
    if (p.needVideo && !video) hint.push(`${p.name} 需要视频`);
    if (p.allowVideo && prefs.withVideo[p.key]) {
      if (!video) hint.push("勾了带视频，但还没有视频");
      else if (currentImages.length && prefs.withImg[p.key] !== false) hint.push("带视频时不会带图");
    }
    const plan = mediaPlan(p, d);
    if (p.kind === "dynamic" && p.maxImages && currentImages.length > p.maxImages && plan.images.length)
      hint.push(`只会带前 ${p.maxImages} 张图`);
    $("[data-hint]", card).textContent = hint.join("；");
  }
  const updateAllCounts = () => enabledPlatforms().forEach(updateCount);

  function renderImages() {
    const el = $("#images");
    if (!el) return;
    el.innerHTML =
      currentImages
        .map(
          (im, i) =>
            `<div class="thumb"><img src="${im.dataUrl}" alt=""><span class="idx">${i + 1}</span><button data-rm="${i}" title="移除">×</button></div>`,
        )
        .join("") + `<div class="add-img" id="addImg">＋ 添加图片<br>可拖拽</div>`;
    $("#addImg").onclick = () => $("#fileInput").click();
    el.querySelectorAll("[data-rm]").forEach(
      (b) =>
        (b.onclick = async () => {
          currentImages.splice(+b.dataset.rm, 1);
          await idb.set(currentId, currentImages);
          renderImages();
          updateAllCounts();
        }),
    );
  }

  function renderVideo() {
    const body = $("#vBody");
    if (!body) return;
    const d = current();
    if (d.videoSource === "url") {
      body.innerHTML = `<input type="url" id="vUrl" style="margin-top:8px" placeholder="https://…/video.mp4（能直接下载的地址，发布时插件会先下载下来）" value="${esc(d.videoUrl)}">
        <div class="video-info" id="vInfo"></div>`;
      const info = () => {
        const u = d.videoUrl.trim();
        const el = $("#vInfo");
        if (!u) {
          el.className = "video-info";
          el.textContent = "链接会随草稿保存。";
        } else if (!/^https:\/\//i.test(u)) {
          el.className = "video-info err";
          el.textContent = "必须是 https:// 开头的链接";
        } else {
          el.className = "video-info ok";
          el.textContent = "已填写视频链接（链接会随草稿保存）";
        }
      };
      info();
      $("#vUrl").oninput = (e) => {
        d.videoUrl = e.target.value;
        touch();
        info();
        updateAllCounts();
      };
    } else {
      const v = localVideos.get(d.id);
      body.innerHTML = `<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="small" id="vPick">${v ? "换一个视频" : "选择视频"}</button>
          ${v ? `<button class="small ghost" id="vClear">移除</button>` : ""}
        </div>
        <div class="video-info ${v ? "ok" : ""}">${v ? `${esc(v.name)}（${mb(v.size)}）· 不会存进草稿，刷新页面后要重新选` : "视频只在本次打开时有效，发布前临时选择即可"}</div>
        ${v ? `<video class="preview" src="${v.previewUrl}" controls muted></video>` : ""}`;
      $("#vPick").onclick = () => $("#videoInput").click();
      const c = $("#vClear");
      if (c)
        c.onclick = () => {
          localVideos.delete(d.id);
          renderVideo();
          updateAllCounts();
        };
    }
    document.querySelectorAll("#vSrc input").forEach(
      (r) =>
        (r.onchange = () => {
          d.videoSource = r.value;
          touch();
          document.querySelectorAll("#vSrc label").forEach((l) => l.classList.toggle("on", l.contains(r)));
          renderVideo();
          updateAllCounts();
        }),
    );
  }

  async function setLocalVideo(file) {
    const d = current();
    if (!d || !file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) return toast("请选择视频文件");
    const old = localVideos.get(d.id);
    if (old && !publishing) URL.revokeObjectURL(old.previewUrl);
    // 插件页面里直接用 blob 地址交给各平台标签页，不受消息大小限制
    const blobUrl = URL.createObjectURL(file);
    localVideos.set(d.id, {
      name: file.name,
      type: file.type || guessVideoType(file.name),
      size: file.size,
      dataUrl: blobUrl,
      previewUrl: blobUrl,
      file,
    });
    log(`视频已就绪：${file.name}（${mb(file.size)}）`);
    if (current()?.id === d.id) {
      renderVideo();
      updateAllCounts();
    }
  }

  async function addFiles(files) {
    const d = current();
    if (!d) return;
    const vids = files.filter((f) => f.type.startsWith("video/"));
    if (vids.length && usesVideo()) {
      if (d.videoSource === "url") {
        d.videoSource = "file";
        touch();
        renderEditor();
      }
      await setLocalVideo(vids[0]);
    }
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    for (const f of imgs) {
      if (f.size > 20 * 1024 * 1024) {
        toast(`${f.name} 超过 20MB，已跳过`);
        continue;
      }
      currentImages.push({ name: f.name, type: f.type, size: f.size, dataUrl: await readAsDataURL(f) });
    }
    await idb.set(d.id, currentImages);
    renderImages();
    updateAllCounts();
  }

  function touch() {
    const d = current();
    d.updatedAt = Date.now();
    saveDrafts();
  }

  function bindEditor() {
    const d = current();
    $("#fTopic").oninput = (e) => {
      d.topic = e.target.value || "未命名草稿";
      touch();
      renderList();
    };
    $("#fTime").oninput = (e) => {
      d.suggestedTime = e.target.value;
      touch();
      renderList();
    };
    $("#btnDelete").onclick = async () => {
      if (!confirm(`删除“${d.topic}”？`)) return;
      drafts = drafts.filter((x) => x.id !== d.id);
      await idb.del(d.id);
      localVideos.delete(d.id);
      saveDrafts();
      currentId = drafts[0]?.id || null;
      renderList();
      renderEditor();
    };

    // 通用文案
    const onCommon = () => {
      touch();
      if (prefs.linked) syncCommonToAll(d);
    };
    const ct = $("#cTitle");
    if (ct)
      ct.oninput = (e) => {
        d.common.title = e.target.value;
        onCommon();
      };
    $("#cContent").oninput = (e) => {
      d.common.content = e.target.value;
      onCommon();
    };
    $("#cTags").oninput = (e) => {
      d.common.tags = normTags(e.target.value);
      onCommon();
    };
    $("#fLinked").onchange = (e) => {
      prefs.linked = e.target.checked;
      savePrefs();
      if (prefs.linked) syncCommonToAll(d);
    };
    $("#btnSyncAll").onclick = () => {
      const plats = enabledPlatforms();
      const changed = plats.filter((p) => {
        const cur = d[p.key],
          want = commonFor(p, d.common);
        const hasText = cur.content.trim() || cur.title.trim() || cur.tags.length;
        return hasText && JSON.stringify(cur) !== JSON.stringify(want);
      });
      if (
        changed.length &&
        !confirm(`会覆盖这些平台已有的文案：${changed.map((p) => p.name).join("、")}\n\n确定同步？`)
      )
        return;
      syncCommonToAll(d);
      toast(`已同步到 ${plats.map((p) => p.name).join("、")}`);
    };

    for (const p of enabledPlatforms()) {
      const card = $(`.card[data-p="${p.key}"]`);
      card.querySelectorAll("[data-f]").forEach(
        (inp) =>
          (inp.oninput = () => {
            const f = inp.dataset.f;
            d[p.key][f] = f === "tags" ? normTags(inp.value) : inp.value;
            touch();
            updateCount(p);
          }),
      );
      $("[data-sel]", card).onchange = (e) => {
        prefs.selected[p.key] = e.target.checked;
        savePrefs();
        card.classList.toggle("off", !e.target.checked);
      };
      $("[data-auto]", card).onchange = (e) => {
        prefs.auto[p.key] = e.target.checked;
        savePrefs();
      };
      const imgSw = $("[data-img]", card);
      if (imgSw)
        imgSw.onchange = (e) => {
          prefs.withImg[p.key] = e.target.checked;
          savePrefs();
          updateCount(p);
        };
      const vidSw = $("[data-vid]", card);
      if (vidSw)
        vidSw.onchange = (e) => {
          prefs.withVideo[p.key] = e.target.checked;
          savePrefs();
          updateCount(p);
        };
      $("[data-copy]", card).onclick = async () => {
        const text = (p.hasTitle && d[p.key].title ? d[p.key].title + "\n\n" : "") + fullText(p, d);
        try {
          await navigator.clipboard.writeText(text);
          toast(`已复制 ${p.name} 全文`);
        } catch {
          toast("复制失败，请手动选择");
        }
      };
      $("[data-fromcommon]", card).onclick = () => {
        d[p.key] = commonFor(p, d.common);
        touch();
        card.querySelectorAll("[data-f]").forEach((inp) => {
          const f = inp.dataset.f;
          inp.value = f === "tags" ? tagsToText(d[p.key].tags) : d[p.key][f] || "";
        });
        updateCount(p);
      };
    }
  }

  /* ---------- 发布记录 ---------- */
  let history = lsGet(LS_HISTORY, []);
  function addHistory(item) {
    history.unshift(item);
    history = history.slice(0, 300);
    lsSet(LS_HISTORY, history);
  }
  function renderHistory() {
    $("#histList").innerHTML = history.length
      ? history
          .map(
            (h) => `<div class="hist-item">
        <div><b>${esc(h.topic)}</b></div>
        <div class="meta">${fmtTime(h.at)} · ${h.space ? "空间：" + esc(h.space) : ""}${h.video ? " · 视频：" + esc(h.video) : ""}</div>
        <div class="res">${h.results.map((r) => `<span class="${r.ok ? "ok" : "bad"}">${esc(r.name)} ${r.ok ? "✓ 已打开" + (r.auto ? "（自动发布）" : "（只填好）") : "✗ " + esc(r.msg || "")}</span>`).join("")}</div>
      </div>`,
          )
          .join("")
      : `<div class="empty">还没有发布记录</div>`;
  }

  /* ---------- 发布 ---------- */
  function validate(d, targets) {
    const problems = [];
    const video = currentVideo(d);
    if (d.videoSource === "url" && d.videoUrl.trim() && !video) problems.push("视频链接必须以 https:// 开头");
    for (const p of targets) {
      const part = d[p.key];
      const plan = mediaPlan(p, d);
      if (!part.content.trim() && p.kind === "dynamic" && !plan.images.length && !plan.video)
        problems.push(`${p.name} 正文是空的`);
      if (countFor(p, d) > p.max) problems.push(`${p.name} 超出字数`);
      if (p.hasTitle && (p.titleRequired || p.needImage) && !part.title.trim()) problems.push(`${p.name} 缺标题`);
      if (p.hasTitle && [...part.title].length > p.titleMax) problems.push(`${p.name} 标题超过 ${p.titleMax} 字`);
      if (p.hasTitle && /[<>]/.test(part.title) && p.key === "youtube") problems.push("YouTube 标题里不能有 < 或 >");
      if (p.needImage && !currentImages.length) problems.push(`${p.name} 需要至少 1 张图`);
      if (p.needVideo && !video) problems.push(`${p.name} 需要视频`);
    }
    return problems;
  }

  /* ---------- 定时发布 ---------- */
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function toLocalInput(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtFull(t) {
    const d = new Date(t);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openSchedule() {
    const d = current();
    if (!d) return toast("先选一条草稿");
    const targets = enabledPlatforms().filter((p) => prefs.selected[p.key]);
    if (!targets.length) return toast("至少勾选一个平台");
    const problems = validate(d, targets);
    if (problems.length) return alert("定时前请先处理：\n\n· " + problems.join("\n· "));
    const next = new Date(Date.now() + 60 * 60 * 1000);
    next.setMinutes(0, 0, 0);
    $("#schedAt").value = toLocalInput(next.getTime());
    $("#schedAuto").checked = true;
    $("#schedInfo").textContent = `草稿「${d.topic}」→ ${targets.map((p) => p.name).join("、")}`;
    $("#dlgSchedule").showModal();
  }

  async function confirmSchedule() {
    const d = current();
    const at = new Date($("#schedAt").value).getTime();
    if (!at || Number.isNaN(at)) return alert("请选择时间");
    if (at < Date.now() + 60 * 1000) return alert("时间至少要在 1 分钟之后");
    const auto = $("#schedAuto").checked;
    const targets = enabledPlatforms().filter((p) => prefs.selected[p.key]);
    const v = currentVideo(d);
    let video = null;
    const needVideo = targets.some((p) => mediaPlan(p, d).video);
    if (needVideo && v) {
      if (d.videoSource === "url") video = { url: d.videoUrl.trim(), name: v.name, type: v.type, size: 0 };
      else {
        const lv = localVideos.get(d.id);
        if (!lv?.file) return alert("请重新选择一次视频文件");
        video = { blob: lv.file, name: lv.name, type: lv.type, size: lv.size };
      }
    }
    const placeholder = video ? { __video: true, name: video.name, type: video.type, size: video.size } : null;
    const steps = targets.map((p) => {
      const plan = mediaPlan(p, d);
      if (plan.video) plan.video = placeholder;
      return {
        key: p.key,
        name: p.name,
        syncData: { platforms: [{ name: p.mp }], isAutoPublish: auto, data: buildData(p, d[p.key], plan) },
      };
    });
    const job = {
      id: uid(),
      at,
      createdAt: Date.now(),
      draftId: d.id,
      topic: d.topic,
      space: settings.space || "",
      auto,
      steps,
      video,
      status: "pending",
    };
    try {
      await putJob(job);
      await scheduleAlarm(job);
    } catch (e) {
      return alert("保存定时任务失败：" + e.message);
    }
    $("#dlgSchedule").close();
    toast(`已定时：${fmtFull(at)}`);
    log(`已创建定时任务「${d.topic}」：${fmtFull(at)}，${targets.map((p) => p.name).join("、")}`);
    refreshJobCount();
  }

  const STATUS_TEXT = {
    pending: "等待中",
    running: "执行中",
    done: "已执行",
    failed: "有失败",
    missed: "已错过",
    cancelled: "已取消",
  };
  async function refreshJobCount() {
    try {
      const jobs = await listJobs();
      const n = jobs.filter((j) => j.status === "pending").length;
      $("#btnJobs").textContent = n ? `定时任务（${n}）` : "定时任务";
      const missed = jobs.filter((j) => j.status === "missed").length;
      if (missed) log(`有 ${missed} 个定时任务错过了，可在“定时任务”里立即发布`);
    } catch (e) {
      console.debug(e);
    }
  }
  async function renderJobs() {
    const jobs = await listJobs();
    const el = $("#jobList");
    if (!jobs.length) {
      el.innerHTML = `<div class="empty">还没有定时任务</div>`;
      return;
    }
    el.innerHTML = jobs
      .map((j) => {
        const late = j.status === "pending" && Date.now() - j.at > MISSED_MS;
        const res = (j.results || [])
          .map(
            (r) => `<span class="${r.ok ? "ok" : "bad"}">${esc(r.name)} ${r.ok ? "✓" : "✗ " + esc(r.msg || "")}</span>`,
          )
          .join("");
        const btns = [];
        if (j.status === "pending") btns.push(`<button class="small" data-job-cancel="${j.id}">取消</button>`);
        if (j.status === "missed" || j.status === "failed")
          btns.push(`<button class="small primary" data-job-now="${j.id}">立即发布</button>`);
        if (j.status !== "pending" && j.status !== "running")
          btns.push(`<button class="small ghost" data-job-del="${j.id}">删除</button>`);
        return `<div class="hist-item">
          <div><b>${esc(j.topic)}</b> <span class="tag ${j.status === "done" ? "done" : ""}">${STATUS_TEXT[j.status] || j.status}${late ? "（已过时）" : ""}</span></div>
          <div class="meta">${fmtFull(j.at)} · ${j.steps.map((s) => s.name).join("、")} · ${j.auto ? "到点自动发布" : "到点只填好"}${j.space ? " · " + esc(j.space) : ""}${j.video ? " · 视频：" + esc(j.video.name) : ""}</div>
          ${j.note ? `<div class="meta">${esc(j.note)}</div>` : ""}
          ${res ? `<div class="res">${res}</div>` : ""}
          ${btns.length ? `<div style="display:flex;gap:6px;margin-top:4px">${btns.join("")}</div>` : ""}
        </div>`;
      })
      .join("");
    el.querySelectorAll("[data-job-cancel]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm("取消这个定时任务？")) return;
          const j = await getJob(b.dataset.jobCancel);
          if (!j) return;
          j.status = "cancelled";
          await putJob(j);
          await clearAlarm(j.id);
          renderJobs();
          refreshJobCount();
        }),
    );
    el.querySelectorAll("[data-job-now]").forEach(
      (b) =>
        (b.onclick = async () => {
          const j = await getJob(b.dataset.jobNow);
          if (!j) return;
          if (!confirm(`现在发布「${j.topic}」到 ${j.steps.map((s) => s.name).join("、")}？`)) return;
          j.status = "pending";
          j.at = Date.now() + 2000;
          j.note = "";
          j.results = [];
          await putJob(j);
          await scheduleAlarm(j);
          toast("马上开始，会打开一个执行页");
          setTimeout(renderJobs, 1500);
        }),
    );
    el.querySelectorAll("[data-job-del]").forEach(
      (b) =>
        (b.onclick = async () => {
          await deleteJob(b.dataset.jobDel);
          renderJobs();
        }),
    );
  }

  async function publish() {
    const d = current();
    if (!d) return toast("先选一条草稿");
    if (publishing) return;
    const targets = enabledPlatforms().filter((p) => prefs.selected[p.key]);
    if (!targets.length) return toast("至少勾选一个平台");

    const problems = validate(d, targets);
    if (problems.length) return alert("发布前请先处理：\n\n· " + problems.join("\n· "));

    const space = settings.space || "";
    const autos = targets.filter((p) => prefs.auto[p.key]).map((p) => p.name);
    const msg =
      (space ? `【当前空间：${space}】\n\n` : "") +
      `将依次打开 ${targets.map((p) => p.name).join("、")} 的发布页并填好内容（请保持本页打开）。\n\n` +
      (autos.length ? `会自动点击发布：${autos.join("、")}\n` : "") +
      (targets.length > autos.length
        ? `只填好不发布（需要你自己点）：${targets
            .filter((p) => !prefs.auto[p.key])
            .map((p) => p.name)
            .join("、")}\n`
        : "") +
      "\n确定继续？";
    if (!confirm(msg)) return;

    publishing = true;
    $("#btnPublish").disabled = true;
    renderBanner();
    const results = [];
    // https 视频链接：先在本页下载成 blob，再交给各平台
    let downloaded = null;
    const needVideo = targets.some((p) => mediaPlan(p, d).video);
    if (needVideo && d.videoSource === "url") {
      try {
        log("正在下载视频链接…");
        const res = await fetch(d.videoUrl.trim());
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        const v = currentVideo(d);
        downloaded = { ...v, url: URL.createObjectURL(blob), type: blob.type || v.type, size: blob.size };
        log(`视频已下载（${mb(blob.size)}）`);
      } catch (e) {
        publishing = false;
        $("#btnPublish").disabled = false;
        renderBanner();
        renderBanner();
        return alert("视频链接下载失败：" + e.message + "\n\n请确认链接能直接下载。");
      }
    }
    try {
      for (let i = 0; i < targets.length; i++) {
        const p = targets[i];
        const part = d[p.key];
        const plan = mediaPlan(p, d);
        if (plan.video && downloaded) plan.video = downloaded;
        const data = buildData(p, part, plan);
        const syncData = { platforms: [{ name: p.mp }], isAutoPublish: !!prefs.auto[p.key], data };
        log(`正在打开 ${p.name}（${i + 1}/${targets.length}）…`);
        const r = await bg("MULTIPOST_EXTENSION_PUBLISH_NOW", syncData, 180000);
        if (!r || !r.tabs) {
          const m = "打开发布页失败或超时";
          results.push({ name: p.name, ok: false, msg: m });
          log(`${p.name} 发送失败：${m}`);
          toast(`${p.name} 发送失败`);
        } else {
          results.push({ name: p.name, ok: true, auto: !!prefs.auto[p.key] });
          d.published = d.published || {};
          d.published[p.key] = Date.now();
          touch();
          const st = $(`.card[data-p="${p.key}"] .st`);
          if (st) {
            st.textContent = "已打开并填写 " + fmtTime(d.published[p.key]);
            st.classList.add("done");
          }
          renderList();
        }
        if (i < targets.length - 1) {
          for (let s = PUBLISH_GAP_MS / 1000; s > 0; s--) {
            log(`${p.name} 已打开，${s} 秒后打开下一个平台…`);
            await sleep(1000);
          }
        }
      }
      log(
        "全部打开完成。请到各平台标签页确认结果" +
          (targets.some((p) => !prefs.auto[p.key]) ? "，没勾自动发布的平台要你自己点发布" : "") +
          "；视频开始上传前别关本页",
      );
    } finally {
      publishing = false;
      $("#btnPublish").disabled = false;
      if (results.length) {
        const v = currentVideo(d);
        addHistory({ at: Date.now(), space, draftId: d.id, topic: d.topic, results, video: v ? v.name : "" });
      }
    }
  }

  /* ---------- 平台设置 ---------- */
  let draftSettings = null;
  function openSettings() {
    draftSettings = JSON.parse(JSON.stringify(settings));
    $("#setSpace").value = draftSettings.space;
    $("#setDraftsUrl").value = draftSettings.draftsUrl || DEFAULT_DRAFTS_URL;
    renderSettings();
    $("#dlgSettings").showModal();
  }
  function renderSettings() {
    $("#setColors").innerHTML = COLORS.map(
      (c) => `<span data-c="${c}" class="${draftSettings.color === c ? "on" : ""}" style="background:${c}"></span>`,
    ).join("");
    $("#setColors")
      .querySelectorAll("[data-c]")
      .forEach(
        (s) =>
          (s.onclick = () => {
            draftSettings.color = s.dataset.c;
            renderSettings();
          }),
      );
    $("#setPlatforms").innerHTML = PLATFORMS.map(
      (p) => `<label class="pf-opt ${draftSettings.enabled.includes(p.key) ? "on" : ""}">
        <input type="checkbox" data-k="${p.key}" ${draftSettings.enabled.includes(p.key) ? "checked" : ""}>${p.name}<span class="kind">${p.kind === "video" ? "视频" : "图文"}</span></label>`,
    ).join("");
    $("#setPlatforms")
      .querySelectorAll("[data-k]")
      .forEach(
        (c) =>
          (c.onchange = () => {
            const k = c.dataset.k;
            draftSettings.enabled = c.checked
              ? [...new Set([...draftSettings.enabled, k])]
              : draftSettings.enabled.filter((x) => x !== k);
            renderSettings();
          }),
      );
  }
  $("#btnSettingsCancel").onclick = () => $("#dlgSettings").close();
  $("#btnSettingsOk").onclick = () => {
    draftSettings.space = $("#setSpace").value.trim();
    draftSettings.draftsUrl = $("#setDraftsUrl").value.trim() || DEFAULT_DRAFTS_URL;
    if (!draftSettings.enabled.length) return alert("至少选一个平台。");
    draftSettings.enabled = PLATFORMS.map((p) => p.key).filter((k) => draftSettings.enabled.includes(k));
    settings = draftSettings;
    lsSet(LS_SETTINGS, settings);
    $("#dlgSettings").close();
    applySpace();
    renderAccounts();
    renderList();
    renderEditor();
    refreshAccounts(true);
    toast("设置已保存");
  };

  /* ---------- 全局绑定 ---------- */
  $("#btnNew").onclick = () => {
    const d = blankDraft();
    drafts.unshift(d);
    saveDrafts();
    currentId = d.id;
    renderList();
    renderEditor();
  };
  $("#draftList").onclick = (e) => {
    const it = e.target.closest(".draft-item");
    if (!it) return;
    currentId = it.dataset.id;
    renderList();
    renderEditor();
  };
  $("#btnImport").onclick = () => {
    $("#importText").value = "";
    $("#dlgImport").showModal();
  };
  $("#btnImportCancel").onclick = () => $("#dlgImport").close();
  $("#btnImportOk").onclick = () => {
    try {
      const list = parseImport($("#importText").value);
      const { added, updated } = mergeDrafts(list);
      $("#dlgImport").close();
      currentId = drafts[0]?.id || currentId;
      renderList();
      renderEditor();
      toast(`导入完成：新增 ${added} 条，更新 ${updated} 条`);
    } catch (e) {
      alert("格式不对，没能解析：\n" + e.message);
    }
  };
  $("#btnSync").onclick = async () => {
    try {
      const url = (settings.draftsUrl || DEFAULT_DRAFTS_URL).trim();
      const res = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 404 ? "仓库里还没有 drafts.json" : "HTTP " + res.status);
      const list = parseImport(await res.text());
      const { added, updated } = mergeDrafts(list);
      if (!currentId) currentId = drafts[0]?.id;
      renderList();
      renderEditor();
      toast(`同步完成：新增 ${added} 条，更新 ${updated} 条`);
    } catch (e) {
      toast("同步失败：" + e.message);
    }
  };
  $("#btnExport").onclick = () => {
    const blob = new Blob([JSON.stringify({ drafts }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `drafts-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("#btnHistory").onclick = () => {
    renderHistory();
    $("#dlgHistory").showModal();
  };
  $("#btnHistClose").onclick = () => $("#dlgHistory").close();
  $("#btnHistClear").onclick = () => {
    if (!confirm("清空全部发布记录？")) return;
    history = [];
    lsSet(LS_HISTORY, history);
    renderHistory();
  };
  $("#btnSettings").onclick = openSettings;
  $("#spaceBadge").onclick = openSettings;
  $("#btnRefreshAcc").onclick = () => refreshAccounts(false);
  $("#btnPublish").onclick = publish;
  $("#btnSchedule").onclick = openSchedule;
  $("#btnSchedOk").onclick = confirmSchedule;
  $("#btnSchedCancel").onclick = () => $("#dlgSchedule").close();
  $("#btnJobs").onclick = async () => {
    await renderJobs();
    $("#dlgJobs").showModal();
  };
  $("#btnJobsClose").onclick = () => $("#dlgJobs").close();
  refreshJobCount();
  $("#fileInput").onchange = (e) => {
    addFiles([...e.target.files]);
    e.target.value = "";
  };
  $("#videoInput").onchange = (e) => {
    setLocalVideo(e.target.files[0]);
    e.target.value = "";
  };
  document.addEventListener("dragover", (e) => {
    if (current()) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!current()) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });
  document.addEventListener("paste", (e) => {
    if (!current() || e.target.closest("textarea, input")) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });
  window.addEventListener("beforeunload", (e) => {
    if (publishing) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  applySpace();
  renderList();
  renderEditor();
  renderAccounts();
  setStatus(`Jeet的社媒工具 v${chrome.runtime.getManifest().version}`);
  loadAccounts().then(() => refreshAccounts(true));
}
