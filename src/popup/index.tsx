import { useEffect } from "react";

// Jeet fork: clicking the toolbar icon opens the built-in publishing console.
const IndexPopup = () => {
  useEffect(() => {
    const url = chrome.runtime.getURL("tabs/console.html");
    chrome.tabs.query({ url }).then((tabs) => {
      const existing = tabs[0];
      if (existing?.id) {
        chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url });
      }
      window.close();
    });
  }, []);

  return <div style={{ padding: 12, fontSize: 13 }}>正在打开发布控制台…</div>;
};

export default IndexPopup;
