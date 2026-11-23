/**
 * Jeet fork: data dashboard — followers and post performance across platforms,
 * read from this browser's own logins and stored locally.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AcctSnapshot,
  type CollectRun,
  PLATFORM_NAMES,
  type PostRecord,
  type RunResult,
  clearDashboardData,
  collectAll,
  dayKey,
  enabledAnalyticsPlatforms,
  loadDashboardData,
} from "~console/analytics";
import {
  type AnalyticsSettings,
  DEFAULT_ANALYTICS_SETTINGS,
  getAnalyticsSettings,
  setAnalyticsSettings,
} from "~console/analytics-alarm";

const COLORS: Record<string, string> = {
  xhs: "#ff2442",
  threads: "#111111",
  x: "#111111",
  tiktok: "#00b8b0",
  youtube: "#ff0000",
  tg: "#229ed9",
};
const DAY = 24 * 60 * 60 * 1000;

const fmt = (n?: number) => {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString("zh-CN");
};
const fmtDelta = (n?: number) => (n === undefined ? "" : n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : "±0");
const fmtTime = (t?: number) => {
  if (!t) return "—";
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const fmtDate = (t?: number) => {
  if (!t) return "—";
  const d = new Date(t);
  return `${d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()}`;
};

/** 每天只留最后一次快照，用来画趋势 */
function dailySeries(snaps: AcctSnapshot[], days = 30) {
  const byDay = new Map<string, AcctSnapshot>();
  for (const s of snaps) byDay.set(s.day, s);
  const from = dayKey(Date.now() - (days - 1) * DAY);
  return [...byDay.values()].filter((s) => s.day >= from).sort((a, b) => a.at - b.at);
}

function deltaSince(snaps: AcctSnapshot[], ms: number, pick: (s: AcctSnapshot) => number | undefined) {
  if (snaps.length < 2) return undefined;
  const latest = snaps[snaps.length - 1];
  const cutoff = latest.at - ms;
  const base = [...snaps].reverse().find((s) => s.at <= cutoff) || snaps[0];
  if (base === latest) return undefined;
  const a = pick(latest);
  const b = pick(base);
  return a !== undefined && b !== undefined ? a - b : undefined;
}

function viewsGrowth(p: PostRecord, ms: number) {
  const h = p.history || [];
  if (h.length < 2) return undefined;
  const latest = h[h.length - 1];
  const base = [...h].reverse().find((x) => x.at <= latest.at - ms) || h[0];
  if (base === latest || latest.views === undefined || base.views === undefined) return undefined;
  return latest.views - base.views;
}

const Spark = ({ values, color }: { values: number[]; color: string }) => {
  if (values.length < 2) return <div className="spark-empty">再更新几天就能看到趋势</div>;
  const w = 240;
  const h = 44;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="粉丝趋势">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

/** 用草稿库里的文案判断哪些内容是用本工具发的 */
function loadDraftFingerprints() {
  const norm = (s: string) =>
    String(s || "")
      .replace(/#[^\s#]+#?/g, "")
      .replace(/\s+/g, "")
      .slice(0, 24);
  const set = new Set<string>();
  try {
    const drafts = JSON.parse(localStorage.getItem("pub.drafts.v1") || "[]");
    for (const d of drafts) {
      for (const k of ["common", "xhs", "threads", "x", "tiktok", "youtube", "tg"]) {
        const part = d?.[k];
        if (!part) continue;
        for (const t of [part.title, part.content]) {
          const n = norm(t);
          if (n.length >= 8) set.add(n);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { set, norm };
}

const SORTS: Record<string, { label: string; fn: (a: PostRecord, b: PostRecord) => number }> = {
  recent: { label: "最新发布", fn: (a, b) => (b.publishedAt || b.firstSeen) - (a.publishedAt || a.firstSeen) },
  views: { label: "播放 / 浏览最多", fn: (a, b) => (b.metrics.views || 0) - (a.metrics.views || 0) },
  likes: { label: "点赞最多", fn: (a, b) => (b.metrics.likes || 0) - (a.metrics.likes || 0) },
  comments: { label: "评论最多", fn: (a, b) => (b.metrics.comments || 0) - (a.metrics.comments || 0) },
  growth: {
    label: "近 7 天播放增长",
    fn: (a, b) => (viewsGrowth(b, 7 * DAY) || 0) - (viewsGrowth(a, 7 * DAY) || 0),
  },
};

const Dashboard = () => {
  const [snapshots, setSnapshots] = useState<AcctSnapshot[]>([]);
  const [posts, setPosts] = useState<PostRecord[]>([]);
  const [runs, setRuns] = useState<CollectRun[]>([]);
  const [settings, setSettings] = useState<AnalyticsSettings>(DEFAULT_ANALYTICS_SETTINGS);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [search, setSearch] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);

  const reload = useCallback(async () => {
    const d = await loadDashboardData();
    setSnapshots(d.snapshots);
    setPosts(d.posts);
    setRuns(d.runs);
  }, []);

  useEffect(() => {
    document.title = "数据看板 · Jeet的社媒工具";
    reload();
    getAnalyticsSettings().then(setSettings);
    const t = setInterval(reload, 30000); // 后台自动更新完后刷新显示
    return () => clearInterval(t);
  }, [reload]);

  const platforms = useMemo(() => {
    const enabled: string[] = enabledAnalyticsPlatforms();
    for (const s of snapshots) if (!enabled.includes(s.platform)) enabled.push(s.platform);
    return enabled;
  }, [snapshots]);

  const lastResult = useMemo(() => {
    const m: Record<string, RunResult & { at: number }> = {};
    for (const r of [...runs].reverse()) for (const x of r.results) m[x.platform] = { ...x, at: r.at };
    return m;
  }, [runs]);

  const byPlatform = useMemo(() => {
    const m: Record<string, AcctSnapshot[]> = {};
    for (const s of snapshots) {
      if (!m[s.platform]) m[s.platform] = [];
      m[s.platform].push(s);
    }
    return m;
  }, [snapshots]);

  const totals = useMemo(() => {
    let followers = 0;
    let week = 0;
    let hasWeek = false;
    for (const p of platforms) {
      const snaps = byPlatform[p] || [];
      const latest = snaps[snaps.length - 1];
      if (latest?.account.followers !== undefined) followers += latest.account.followers;
      const d = deltaSince(snaps, 7 * DAY, (s) => s.account.followers);
      if (d !== undefined) {
        week += d;
        hasWeek = true;
      }
    }
    const recentViews = posts
      .filter((p) => (p.publishedAt || p.firstSeen) >= Date.now() - 30 * DAY)
      .reduce((s, p) => s + (p.metrics.views || 0), 0);
    return { followers, week: hasWeek ? week : undefined, recentViews };
  }, [platforms, byPlatform, posts]);

  const fp = useMemo(loadDraftFingerprints, []);
  const isMine = useCallback(
    (p: PostRecord) => {
      const n = fp.norm(p.title);
      if (n.length < 8) return false;
      for (const f of fp.set)
        if (n.startsWith(f.slice(0, Math.min(f.length, n.length))) || f.startsWith(n)) return true;
      return false;
    },
    [fp],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return posts
      .filter((p) => platformFilter === "all" || p.platform === platformFilter)
      .filter((p) => !q || p.title.toLowerCase().includes(q))
      .filter((p) => !onlyMine || isMine(p))
      .sort(SORTS[sort].fn)
      .slice(0, 300);
  }, [posts, platformFilter, search, sort, onlyMine, isMine]);

  const runNow = async () => {
    if (running) return;
    setRunning(true);
    setProgress("开始更新…");
    try {
      await collectAll(enabledAnalyticsPlatforms(), "manual", (msg) => setProgress(msg));
    } catch (e) {
      setProgress(`出错：${(e as Error).message}`);
    } finally {
      setRunning(false);
      await reload();
    }
  };

  const saveSettings = async (s: AnalyticsSettings) => {
    setSettings(s);
    await setAnalyticsSettings(s);
  };

  const clearAll = async () => {
    if (!window.confirm("清空这个浏览器里保存的所有看板数据？（不影响各平台上的内容）")) return;
    await clearDashboardData();
    await reload();
  };

  const lastRun = runs[0];

  return (
    <div className="dash">
      <style>{CSS}</style>
      <header>
        <img src={chrome.runtime.getURL(chrome.runtime.getManifest().icons?.["128"] ?? "")} alt="" />
        <h1>数据看板</h1>
        <span className="sub">
          上次更新：{lastRun ? fmtTime(lastRun.finishedAt || lastRun.at) : "还没有更新过"}
          {settings.auto ? ` · 每天 ${settings.hour}:00 自动更新` : " · 自动更新已关闭"}
        </span>
        <span className="grow" />
        <a className="btn ghost" href={chrome.runtime.getURL("tabs/console.html")}>
          ← 发布控制台
        </a>
        <button type="button" className="btn primary" disabled={running} onClick={runNow}>
          {running ? "更新中…" : "立即更新"}
        </button>
      </header>

      <main>
        {(running || progress) && (
          <div className={`banner ${running ? "" : "done"}`}>
            {running ? progress : "更新完成。"}
            {running && " 会在后台依次打开各平台的数据页读取数字，读完自动关掉，请不要关闭本页。"}
          </div>
        )}

        <section className="totals">
          <div className="total">
            <div className="label">总粉丝</div>
            <div className="value">{fmt(totals.followers)}</div>
            {totals.week !== undefined ? (
              <div className={`delta ${totals.week < 0 ? "down" : "up"}`}>近 7 天 {fmtDelta(totals.week)}</div>
            ) : (
              <div className="delta muted">近 7 天变化：再更新几天可见</div>
            )}
          </div>
          <div className="total">
            <div className="label">近 30 天发布内容的播放 / 浏览</div>
            <div className="value">{fmt(totals.recentViews)}</div>
            <div className="delta muted">按各平台最新读数相加</div>
          </div>
          <div className="total">
            <div className="label">追踪中的内容</div>
            <div className="value">{fmt(posts.length)}</div>
            <div className="delta muted">每次更新会读取各平台最近的内容</div>
          </div>
        </section>

        <section className="cards">
          {platforms.map((p) => {
            const snaps = byPlatform[p] || [];
            const latest = snaps[snaps.length - 1];
            const series = dailySeries(snaps).map((s) => s.account.followers ?? 0);
            const d7 = deltaSince(snaps, 7 * DAY, (s) => s.account.followers);
            const lr = lastResult[p];
            const a = latest?.account;
            return (
              <div className="card" key={p}>
                <div className="card-h">
                  <span className="dot" style={{ background: COLORS[p] }} />
                  <b>{PLATFORM_NAMES[p] || p}</b>
                  <span className="acc">{a?.name || a?.handle || ""}</span>
                  {a?.url && (
                    <a className="link" href={a.url} target="_blank" rel="noreferrer">
                      打开
                    </a>
                  )}
                </div>
                <div className="big">
                  {fmt(a?.followers)}
                  <span className="unit">{p === "youtube" ? "订阅" : p === "tg" ? "订阅者" : "粉丝"}</span>
                  {d7 !== undefined && <span className={`delta ${d7 < 0 ? "down" : "up"}`}>{fmtDelta(d7)} / 7天</span>}
                </div>
                <Spark values={series} color={COLORS[p] || "#555"} />
                <div className="kv">
                  {a?.following !== undefined && (
                    <span>
                      关注 <b>{fmt(a.following)}</b>
                    </span>
                  )}
                  {a?.posts !== undefined && (
                    <span>
                      作品 <b>{fmt(a.posts)}</b>
                    </span>
                  )}
                  {a?.likes !== undefined && (
                    <span>
                      {p === "xhs" ? "获赞与收藏" : "获赞"} <b>{fmt(a.likes)}</b>
                    </span>
                  )}
                  {a?.views !== undefined && p === "youtube" && (
                    <span>
                      总播放 <b>{fmt(a.views)}</b>
                    </span>
                  )}
                </div>
                {latest?.summary?.length ? (
                  <div className="summary">
                    <div className="summary-h">{latest.summaryLabel}</div>
                    {latest.summary.map((s) => (
                      <span key={s.label}>
                        {s.label} <b>{fmt(s.value)}</b>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className={`status ${lr && !lr.ok ? "bad" : ""}`}>
                  {lr
                    ? lr.ok
                      ? `${fmtTime(latest?.at)} 更新 · 读到 ${lr.posts ?? 0} 条内容`
                      : `上次更新失败：${lr.msg}`
                    : latest
                      ? `${fmtTime(latest.at)} 更新`
                      : "还没有数据，点右上角“立即更新”"}
                </div>
              </div>
            );
          })}
        </section>

        <section className="panel">
          <div className="panel-h">
            <b>内容表现</b>
            <span className="grow" />
            <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}>
              <option value="all">全部平台</option>
              {platforms
                .filter((p) => p !== "tg")
                .map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_NAMES[p] || p}
                  </option>
                ))}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {Object.entries(SORTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
            <input type="text" placeholder="搜索内容" value={search} onChange={(e) => setSearch(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              只看本工具发的
            </label>
          </div>
          {rows.length === 0 ? (
            <div className="empty">{posts.length ? "没有符合条件的内容" : "还没有内容数据，点右上角“立即更新”"}</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>平台</th>
                    <th className="title-col">内容</th>
                    <th>发布</th>
                    <th>播放 / 浏览</th>
                    <th>点赞</th>
                    <th>评论</th>
                    <th>转发</th>
                    <th>收藏</th>
                    <th>7 天新增播放</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const g = viewsGrowth(p, 7 * DAY);
                    return (
                      <tr key={p.key}>
                        <td>
                          <span className="dot" style={{ background: COLORS[p.platform] }} />
                          {PLATFORM_NAMES[p.platform] || p.platform}
                        </td>
                        <td className="title-col">
                          {p.url ? (
                            <a href={p.url} target="_blank" rel="noreferrer">
                              {p.title}
                            </a>
                          ) : (
                            p.title
                          )}
                          {p.type && <span className="tag">{p.type}</span>}
                          {isMine(p) && <span className="tag mine">本工具发布</span>}
                        </td>
                        <td title={p.publishedAt ? "" : "平台没有提供发布时间"}>{fmtDate(p.publishedAt)}</td>
                        <td className="n">{fmt(p.metrics.views)}</td>
                        <td className="n">{fmt(p.metrics.likes)}</td>
                        <td className="n">{fmt(p.metrics.comments)}</td>
                        <td className="n">{fmt(p.metrics.shares)}</td>
                        <td className="n">{fmt(p.metrics.saves)}</td>
                        <td className={`n ${g && g > 0 ? "up" : ""}`}>{g === undefined ? "—" : fmtDelta(g)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-h">
            <b>设置</b>
          </div>
          <div className="settings">
            <label className="check">
              <input
                type="checkbox"
                checked={settings.auto}
                onChange={(e) => saveSettings({ ...settings, auto: e.target.checked })}
              />
              每天自动更新一次
            </label>
            <label>
              时间
              <select
                value={settings.hour}
                disabled={!settings.auto}
                onChange={(e) => saveSettings({ ...settings, hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">
              到点时电脑和 Chrome 要开着。读取的是“平台设置”里打开的平台，用的是这个浏览器里已登录的账号。
            </span>
            <span className="grow" />
            <button type="button" className="btn ghost danger" onClick={clearAll}>
              清空看板数据
            </button>
          </div>
          {runs.length > 0 && (
            <div className="runs">
              <div className="summary-h">最近几次更新</div>
              {runs.slice(0, 5).map((r) => (
                <div key={r.id ?? r.at} className="run">
                  <span className="muted">
                    {fmtTime(r.at)} · {r.trigger === "auto" ? "自动" : "手动"}
                  </span>
                  {r.results.map((x) => (
                    <span key={x.platform} className={x.ok ? "ok" : "bad"} title={x.msg}>
                      {PLATFORM_NAMES[x.platform] || x.platform} {x.ok ? "✓" : "✗"}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f6f5f2;color:#1d1d1f;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif}
.dash header{display:flex;align-items:center;gap:12px;padding:12px 24px;background:#fff;border-bottom:1px solid #e4e2dc;position:sticky;top:0;z-index:5;flex-wrap:wrap}
.dash header img{width:28px;height:28px;border-radius:7px}
.dash header h1{font-size:17px;margin:0}
.dash .sub{color:#6e6e73;font-size:12.5px}
.dash .grow{flex:1}
.dash .btn{font:inherit;border:1px solid #e4e2dc;background:#fff;border-radius:8px;padding:6px 14px;cursor:pointer;color:#1d1d1f;text-decoration:none}
.dash .btn:disabled{opacity:.5;cursor:default}
.dash .btn.primary{background:#1f6f5c;border-color:#1f6f5c;color:#fff;font-weight:600}
.dash .btn.ghost{border-color:transparent;color:#6e6e73}
.dash .btn.ghost:hover{background:#efede8;color:#1d1d1f}
.dash .btn.danger{color:#b42318}
.dash main{max-width:1320px;margin:0 auto;padding:20px 24px 60px}
.dash .banner{background:#e3f0ec;color:#1f6f5c;padding:10px 14px;border-radius:10px;margin-bottom:16px;font-size:13px}
.dash .banner.done{background:#efede8;color:#6e6e73}
.dash .totals{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}
.dash .total{background:#fff;border:1px solid #e4e2dc;border-radius:12px;padding:16px}
.dash .total .label{color:#6e6e73;font-size:12.5px}
.dash .total .value{font-size:28px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
.dash .delta{font-size:12.5px;font-weight:600}
.dash .delta.up{color:#1f6f5c}.dash .delta.down{color:#b42318}.dash .muted{color:#6e6e73;font-weight:400;font-size:12.5px}
.dash .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-bottom:16px}
.dash .card{background:#fff;border:1px solid #e4e2dc;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.dash .card-h{display:flex;align-items:center;gap:8px}
.dash .card-h .acc{color:#6e6e73;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dash .card-h .link{font-size:12px;color:#6e6e73}
.dash .dot{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:middle}
.dash .card-h .dot{margin-right:0}
.dash .big{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dash .big .unit{font-size:12.5px;color:#6e6e73;font-weight:400}
.dash .spark{width:100%;height:44px;display:block}
.dash .spark-empty{height:44px;display:flex;align-items:center;color:#b0aea8;font-size:12px}
.dash .kv,.dash .summary{display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;color:#6e6e73}
.dash .kv b,.dash .summary b{color:#1d1d1f;font-variant-numeric:tabular-nums}
.dash .summary{background:#f6f5f2;border-radius:8px;padding:8px 10px}
.dash .summary-h{width:100%;font-size:11.5px;color:#6e6e73;margin-bottom:-4px}
.dash .status{font-size:12px;color:#6e6e73;border-top:1px solid #efede8;padding-top:8px}
.dash .status.bad{color:#b42318}
.dash .panel{background:#fff;border:1px solid #e4e2dc;border-radius:12px;padding:14px 16px;margin-bottom:16px}
.dash .panel-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.dash select,.dash input[type=text]{font:inherit;border:1px solid #e4e2dc;border-radius:8px;padding:5px 8px;background:#fff}
.dash .check{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}
.dash .table-wrap{overflow:auto;max-height:640px}
.dash table{width:100%;border-collapse:collapse;font-size:13px}
.dash th{position:sticky;top:0;background:#fff;text-align:right;font-weight:600;color:#6e6e73;font-size:12px;padding:8px;border-bottom:1px solid #e4e2dc;white-space:nowrap}
.dash th:first-child,.dash th.title-col{text-align:left}
.dash td{padding:8px;border-bottom:1px solid #f0eee9;white-space:nowrap}
.dash td.n{text-align:right;font-variant-numeric:tabular-nums}
.dash td.n.up{color:#1f6f5c;font-weight:600}
.dash td.title-col{white-space:normal;min-width:280px;max-width:520px}
.dash td.title-col a{color:#1d1d1f;text-decoration:none}
.dash td.title-col a:hover{text-decoration:underline}
.dash .tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:4px;background:#efede8;color:#6e6e73;margin-left:6px}
.dash .tag.mine{background:#e3f0ec;color:#1f6f5c}
.dash .empty{color:#6e6e73;padding:30px 0;text-align:center}
.dash .settings{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.dash .settings label{display:inline-flex;align-items:center;gap:6px}
.dash .runs{margin-top:12px;border-top:1px solid #efede8;padding-top:10px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.dash .run{display:flex;gap:10px;flex-wrap:wrap}
.dash .run .ok{color:#1f6f5c}.dash .run .bad{color:#b42318}
@media (max-width:900px){.dash .totals{grid-template-columns:1fr}}
`;

export default Dashboard;
