/**
 * Jeet fork: read login info by opening the platform in a background tab.
 * Used for platforms whose account info is only available after client-side rendering
 * (小红书) or that have no account API (Threads). Only runs when explicitly allowed,
 * so opening the console doesn't flash tabs.
 */

let probeAllowed = true;
export function setProbeAllowed(v: boolean) {
  probeAllowed = v;
}

export class ProbeSkippedError extends Error {
  constructor() {
    super("skip tab probe");
    this.name = "ProbeSkippedError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function probeInTab<T>(url: string, fn: () => T | null, timeoutMs = 20000): Promise<T | null> {
  if (!probeAllowed) throw new ProbeSkippedError();
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id as number;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") break;
      await sleep(500);
    }
    while (Date.now() < deadline) {
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: fn });
        if (res?.result) return res.result as T;
      } catch (e) {
        console.debug("probe script failed", e);
      }
      await sleep(1000);
    }
    return null;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}
