/**
 * useNotifications — in-app and Web Push notification delivery for calendar events.
 *
 * Polls every 30 seconds to check whether any upcoming event falls within its
 * alert window (determined by `allDayMinsBefore` / `timedMinsBefore` settings).
 * When an event enters the window, it is marked as notified in localStorage
 * (scoped to the current day) and either:
 *   - Shown as an in-app alert banner, or
 *   - Fired as a browser Notification (Web Push), or both.
 *
 * The notified-event set resets each calendar day so recurring daily events
 * can re-fire.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useCalendar } from "../contexts/CalendarContext";
import { useSettings } from "../contexts/SettingsContext";
import type { CalendarEvent } from "../lib/nostr";
import { sendNotification } from "../lib/notify";
import { isTauri } from "../lib/platform";
import { lsSet, lsGet } from "../lib/storage";
const CHECK_INTERVAL_MS = 30_000; // check every 30s
const STORAGE_KEY = "nostr-planner-notified";

function getNotified(): Set<string> {
  try {
    const raw = lsGet(STORAGE_KEY);
    if (!raw) return new Set();
    const { date, ids } = JSON.parse(raw);
    if (date !== new Date().toDateString()) return new Set();
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function markNotified(dTag: string) {
  const notified = getNotified();
  notified.add(dTag);
  lsSet(
    STORAGE_KEY,
    JSON.stringify({ date: new Date().toDateString(), ids: [...notified] })
  );
}

export interface PendingAlert {
  event: CalendarEvent;
  message: string;
}

export function useNotifications(): {
  alerts: PendingAlert[];
  dismiss: (dTag: string) => void;
} {
  const { events } = useCalendar();
  const { notification } = useSettings();
  const [alerts, setAlerts] = useState<PendingAlert[]>([]);
  const eventsRef = useRef(events);
  const notifRef = useRef(notification);
  // Keep refs in sync so interval callbacks always see the latest values
  // without needing them in the dependency array (which would restart the timer).
  useEffect(() => {
    eventsRef.current = events;
    notifRef.current = notification;
  }, [events, notification]);

  const dismiss = useCallback((dTag: string) => {
    markNotified(dTag);
    setAlerts((prev) => prev.filter((a) => a.event.dTag !== dTag));
  }, []);

  useEffect(() => {
    if (!notification.enabled) {
      // Intentional: clear stale alerts immediately when notifications are disabled.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAlerts([]);
      return;
    }

    const check = () => {
      const n = notifRef.current;
      if (!n.enabled) return;
      const now = Date.now();
      const notified = getNotified();
      const newAlerts: PendingAlert[] = [];

      for (const event of eventsRef.current) {
        if (event.notify === false) continue;
        if (notified.has(event.dTag)) continue;

        const minsBefore = event.allDay ? n.allDayMinsBefore : n.timedMinsBefore;
        const eventTime = event.start.getTime();
        const alertTime = eventTime - minsBefore * 60_000;

        // Fire if in window: alert time has passed but event hasn't started + 5 min grace
        if (now >= alertTime && now < eventTime + 5 * 60_000) {
          // Mark notified immediately to prevent duplicate alerts from concurrent checks
          markNotified(event.dTag);
          notified.add(event.dTag);

          const minsUntil = Math.max(0, Math.round((eventTime - now) / 60_000));
          const timeStr =
            minsUntil === 0
              ? "starting now"
              : minsUntil < 60
                ? `in ${minsUntil} min${minsUntil !== 1 ? "s" : ""}`
                : `in ${Math.round(minsUntil / 60)} hr${Math.round(minsUntil / 60) !== 1 ? "s" : ""}`;

          const message = `${event.title} — ${timeStr}`;

          // On Tauri the OS-scheduled notification (see
          // useTauriScheduledNotifications) already fires at this time, so
          // skip the foreground-polled send to avoid a duplicate banner.
          if (n.method === "push" && !isTauri()) {
            sendNotification({
              title: event.title,
              body: `Event ${timeStr}`,
              tag: event.title,
            });
          }

          if (n.method === "in-app" || n.method === "push") {
            newAlerts.push({ event, message });
          }
        }
      }

      if (newAlerts.length > 0) {
        setAlerts((prev) => {
          const existing = new Set(prev.map((a) => a.event.dTag));
          const deduped = newAlerts.filter((a) => !existing.has(a.event.dTag));
          return deduped.length > 0 ? [...prev, ...deduped] : prev;
        });
      }
    };

    check();
    let interval: ReturnType<typeof setInterval> | null = setInterval(check, CHECK_INTERVAL_MS);

    // Pause polling when the tab is backgrounded to save battery (especially on mobile).
    const handleVisibility = () => {
      if (document.hidden) {
        if (interval) { clearInterval(interval); interval = null; }
      } else {
        if (!interval) {
          check(); // run immediately on resume
          interval = setInterval(check, CHECK_INTERVAL_MS);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (interval) clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [notification.enabled]);

  return { alerts, dismiss };
}

