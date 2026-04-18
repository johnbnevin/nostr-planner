/**
 * useTauriScheduledNotifications — OS-level scheduled notifications on Tauri.
 *
 * The web path uses `useDigest` + service worker + VAPID push so notifications
 * fire while the browser is closed. Tauri WebView has no service workers, so
 * we instead pre-schedule local notifications with the OS via
 * `@tauri-apps/plugin-notification`. The OS then fires them at the right time
 * even if the Tauri app isn't running.
 *
 * Invariants:
 * - No-ops on web builds.
 * - Only active when notifications are enabled AND method === "push".
 * - Reschedules when the event set or timing settings change (debounced).
 * - Caps the upcoming window to 30 days / 64 notifications to stay under
 *   iOS's 64-pending-notification limit.
 */

import { useEffect, useRef } from "react";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";
import { isTauri } from "../lib/platform";
import { logger } from "../lib/logger";

const log = logger("tauri-notify");

const SCHEDULE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 60;
const DEBOUNCE_MS = 1_000;

/** Stable positive 31-bit int derived from a dTag. Tauri notification IDs
 *  are numeric; we need deterministic IDs so a reschedule can replace
 *  prior entries for the same event instead of leaking duplicates. */
function stableId(dTag: string): number {
  let h = 2166136261;
  for (let i = 0; i < dTag.length; i++) {
    h ^= dTag.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h & 0x7fffffff) || 1;
}

export function useTauriScheduledNotifications(): void {
  const { events } = useCalendar();
  const { notification } = useSettings();
  const prevKey = useRef("");

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;

    const run = async () => {
      try {
        const plugin = await import("@tauri-apps/plugin-notification");

        if (!notification.enabled || notification.method !== "push") {
          if (prevKey.current !== "") {
            await plugin.cancelAll();
            prevKey.current = "";
          }
          return;
        }

        const granted = await plugin.isPermissionGranted();
        if (!granted) {
          const r = await plugin.requestPermission();
          if (r !== "granted") return;
        }

        const now = Date.now();
        const upcoming = events
          .filter((e) => e.notify !== false)
          .map((e) => {
            const mins = e.allDay ? notification.allDayMinsBefore : notification.timedMinsBefore;
            return { event: e, alertMs: e.start.getTime() - mins * 60_000 };
          })
          .filter(({ alertMs }) => alertMs > now && alertMs < now + SCHEDULE_WINDOW_MS)
          .sort((a, b) => a.alertMs - b.alertMs)
          .slice(0, MAX_PENDING);

        const key = upcoming.map(({ event, alertMs }) => `${event.dTag}:${alertMs}:${event.title}`).join("|");
        if (key === prevKey.current) return;

        await plugin.cancelAll();
        if (cancelled) return;

        for (const { event, alertMs } of upcoming) {
          try {
            plugin.sendNotification({
              id: stableId(event.dTag),
              title: event.title,
              body: event.allDay
                ? event.start.toDateString()
                : `At ${event.start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
              schedule: plugin.Schedule.at(new Date(alertMs), false, true),
            });
          } catch (err) {
            log.warn("schedule failed for", event.title, err);
          }
        }

        prevKey.current = key;
        log.info(`scheduled ${upcoming.length} notifications`);
      } catch (err) {
        log.warn("reschedule failed:", err);
      }
    };

    const handle = setTimeout(() => { void run(); }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [events, notification]);
}
