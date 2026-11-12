// Jeet fork: scheduled publishing — fire alarms and keep them in sync with saved jobs.
import { ALARM_PREFIX, openRunner, resyncAlarms } from "~console/scheduler";

export function initScheduler() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    openRunner(alarm.name.slice(ALARM_PREFIX.length)).catch((e) => console.error("open runner failed", e));
  });
  chrome.runtime.onStartup.addListener(() => {
    resyncAlarms().catch((e) => console.error("resync alarms failed", e));
  });
  chrome.runtime.onInstalled.addListener(() => {
    resyncAlarms().catch((e) => console.error("resync alarms failed", e));
  });
}
