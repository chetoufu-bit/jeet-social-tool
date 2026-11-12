/**
 * Jeet的社媒工具 — built-in publishing console (Jeet fork of MultiPost).
 * Platforms: 小红书 / Threads / X / TikTok / YouTube. Logic lives in ~console/app.
 */
import { useEffect } from "react";
import { initConsole } from "~console/app";
import { CONSOLE_CSS, CONSOLE_MARKUP } from "~console/markup";

const Console = () => {
  useEffect(() => {
    document.title = "Jeet的社媒工具";
    initConsole();
  }, []);

  return (
    <>
      <style>{CONSOLE_CSS}</style>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static markup bundled with the extension */}
      <div dangerouslySetInnerHTML={{ __html: CONSOLE_MARKUP }} />
    </>
  );
};

export default Console;
