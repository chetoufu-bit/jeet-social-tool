// Jeet fork: scheduled publishing + daily data-dashboard update — fire alarms and keep them in sync.
import { ANALYTICS_ALARM, ensureAnalyticsAlarm, openAnalyticsRunner } from "~console/analytics-alarm";
import { ALARM_PREFIX, openRunner, resyncAlarms } from "~console/scheduler";

export function initScheduler() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ANALYTICS_ALARM) {
      openAnalyticsRunner().catch((e) => console.error("open analytics runner failed", e));
      return;
    }
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    openRunner(alarm.name.slice(ALARM_PREFIX.length)).catch((e) => console.error("open runner failed", e));
  });
  const resync = () => {
    resyncAlarms().catch((e) => console.error("resync alarms failed", e));
    ensureAnalyticsAlarm().catch((e) => console.error("analytics alarm failed", e));
  };
  chrome.runtime.onStartup.addListener(resync);
  chrome.runtime.onInstalled.addListener(resync);
}
