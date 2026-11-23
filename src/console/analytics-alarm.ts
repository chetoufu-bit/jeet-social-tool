/**
 * Jeet fork: daily alarm for the data dashboard (used by the background and the dashboard page).
 */
export const ANALYTICS_ALARM = "jeet-analytics";
export const ANALYTICS_SETTINGS_KEY = "jeet.analytics";

export interface AnalyticsSettings {
  /** 每天自动更新 */
  auto: boolean;
  /** 几点更新（本机时间，0–23） */
  hour: number;
}

export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = { auto: true, hour: 9 };

export async function getAnalyticsSettings(): Promise<AnalyticsSettings> {
  const v = (await chrome.storage.local.get(ANALYTICS_SETTINGS_KEY))[ANALYTICS_SETTINGS_KEY];
  return { ...DEFAULT_ANALYTICS_SETTINGS, ...(v || {}) };
}

export async function setAnalyticsSettings(s: AnalyticsSettings) {
  await chrome.storage.local.set({ [ANALYTICS_SETTINGS_KEY]: s });
  await ensureAnalyticsAlarm(true);
}

/** Create (or re-create) the daily alarm to match the settings. */
export async function ensureAnalyticsAlarm(force = false) {
  const s = await getAnalyticsSettings();
  if (!s.auto) {
    await chrome.alarms.clear(ANALYTICS_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(ANALYTICS_ALARM);
  if (existing && !force) return;
  const next = new Date();
  next.setHours(s.hour, 0, 0, 0);
  if (next.getTime() <= Date.now() + 60 * 1000) next.setDate(next.getDate() + 1);
  await chrome.alarms.create(ANALYTICS_ALARM, { when: next.getTime(), periodInMinutes: 24 * 60 });
}

export async function openAnalyticsRunner() {
  const url = chrome.runtime.getURL("tabs/analytics-run.html");
  const open = await chrome.tabs.query({ url });
  if (open.length) return;
  try {
    await chrome.tabs.create({ url, active: false });
  } catch {
    await chrome.windows.create({ url, focused: false });
  }
}
