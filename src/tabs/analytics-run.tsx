/**
 * Jeet fork: runs the daily data update (opened in the background by the alarm) and closes itself.
 */
import { useEffect, useState } from "react";
import { PLATFORM_NAMES, collectAll, enabledAnalyticsPlatforms } from "~console/analytics";

const AnalyticsRun = () => {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    document.title = "正在更新数据 · Jeet的社媒工具";
    const log = (m: string) => setLines((l) => [...l, `${new Date().toLocaleTimeString()}  ${m}`]);
    const platforms = enabledAnalyticsPlatforms();
    collectAll(platforms, "auto", (msg) => log(msg))
      .then((run) => {
        if (!run) return;
        const ok = run.results.filter((r) => r.ok).map((r) => PLATFORM_NAMES[r.platform]);
        const bad = run.results.filter((r) => !r.ok).map((r) => `${PLATFORM_NAMES[r.platform]}（${r.msg}）`);
        for (const r of run.results)
          log(`${PLATFORM_NAMES[r.platform]}：${r.ok ? `已更新，${r.posts ?? 0} 条内容` : r.msg}`);
        if (bad.length) {
          try {
            const icon = chrome.runtime.getManifest().icons?.["128"];
            chrome.notifications?.create({
              type: "basic",
              iconUrl: chrome.runtime.getURL(icon || ""),
              title: "数据看板有平台没更新成功",
              message: `${ok.length ? `已更新：${ok.join("、")}；` : ""}失败：${bad.join("；")}`,
            });
          } catch {
            /* ignore */
          }
        }
      })
      .catch((e) => log(`出错：${(e as Error).message}`))
      .finally(() => setTimeout(() => window.close(), 8000));
  }, []);

  return (
    <div style={{ font: "14px/1.6 -apple-system,'PingFang SC',sans-serif", padding: 24, maxWidth: 760 }}>
      <h2 style={{ margin: "0 0 8px" }}>正在更新数据看板</h2>
      <p style={{ color: "#6e6e73", margin: "0 0 16px" }}>
        会在后台依次打开各平台的数据页读取数字，读完自动关闭，完成后本页也会自动关闭。
      </p>
      <pre style={{ background: "#f6f5f2", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap" }}>
        {lines.join("\n") || "准备中…"}
      </pre>
    </div>
  );
};

export default AnalyticsRun;
