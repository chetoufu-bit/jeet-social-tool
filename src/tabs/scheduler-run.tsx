/**
 * Jeet fork: runner page for a scheduled publishing job (opened by the background alarm).
 * Must stay open while platform tabs read the video from it; closes itself after 15 minutes.
 */
import { useEffect, useState } from "react";
import { runJob } from "~console/scheduler";

const KEEP_OPEN_MS = 15 * 60 * 1000;

const SchedulerRun = () => {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    document.title = "定时发布执行中 · Jeet的社媒工具";
    const id = decodeURIComponent(location.hash.slice(1));
    const log = (msg: string) => setLines((l) => [...l, `${new Date().toLocaleTimeString()}  ${msg}`]);
    runJob(id, log).finally(() => {
      setTimeout(() => window.close(), KEEP_OPEN_MS);
    });
  }, []);

  return (
    <div style={{ font: "14px/1.6 -apple-system,'PingFang SC',sans-serif", padding: 24, maxWidth: 760 }}>
      <h2 style={{ margin: "0 0 8px" }}>定时发布</h2>
      <p style={{ color: "#6e6e73", margin: "0 0 16px" }}>
        各平台标签页会从本页读取视频，请不要关闭本页；15 分钟后会自动关闭。
      </p>
      <pre style={{ background: "#f6f5f2", padding: 12, borderRadius: 8, whiteSpace: "pre-wrap" }}>
        {lines.join("\n") || "准备中…"}
      </pre>
    </div>
  );
};

export default SchedulerRun;
