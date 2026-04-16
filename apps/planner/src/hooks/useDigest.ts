/**
 * useDigest — auto-publish push data snapshots and Web Push subscriptions to Nostr.
 *
 * Two independent effects:
 *   1. **Push data** — a snapshot of upcoming events, habits, and tasks,
 *      published once per app load after all data finishes loading. The daemon
 *      uses this data to determine when to fire push notifications.
 *   2. **Push subscription** — when push notifications are enabled, the browser's
 *      PushSubscription is registered with the service worker and published as
 *      an encrypted event so the push daemon can deliver notifications.
 */

import { useEffect, useRef } from "react";
import { useNostr } from "../contexts/NostrContext";
import { useCalendar } from "../contexts/CalendarContext";
import { useTasks } from "../contexts/TasksContext";
import { useSettings } from "../contexts/SettingsContext";
import { isNip44Available } from "../lib/crypto";
import {
  buildDigestData,
  publishDigestData,
  registerPushSubscription,
  publishPushSubscription,
} from "../lib/digest";
import { logger } from "../lib/logger";

const log = logger("digest");

export function useDigest() {
  const { pubkey, signEvent, publishEvent, signer } = useNostr();
  const { events, calendars, eventsLoading: calLoading } = useCalendar();
  const { habits, completions, lists, loading: tasksLoading } = useTasks();
  const { notification } = useSettings();

  const dataPublished = useRef(false);
  const pushPublished = useRef<string>("");

  // Publish push data once after events + tasks finish loading.
  // Published whenever notifications are enabled (any method), not just "push".
  // This ensures the daemon has a fresh snapshot if the user also has a web
  // session with push enabled, or if they switch to push later.
  useEffect(() => {
    if (!pubkey || !isNip44Available(signer)) return;
    if (!notification.enabled) return;
    if (calLoading || tasksLoading) return;
    if (dataPublished.current) return;

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const payload = buildDigestData({
      events, calendars, habits, completions, lists,
      timezone,
    });

    publishDigestData({ payload, signEvent, publishEvent, nip44: signer!.nip44 })
      .then(() => { dataPublished.current = true; })
      .catch((err) => log.warn("data publish failed", err));
  }, [
    pubkey, notification, calLoading, tasksLoading,
    events, calendars, habits, completions, lists,
    signEvent, publishEvent, signer,
  ]);

  // Register push subscription and publish to Nostr when push is enabled
  useEffect(() => {
    if (!pubkey || !isNip44Available(signer)) return;
    if (!notification.enabled || notification.method !== "push") return;

    const pushKey = JSON.stringify({
      method: notification.method,
      allDay: notification.allDayMinsBefore,
      timed: notification.timedMinsBefore,
    });
    if (pushKey === pushPublished.current) return;

    let mounted = true;
    (async () => {
      try {
        const sub = await registerPushSubscription();
        if (!sub || !mounted) return;

        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        await publishPushSubscription({
          subscription: sub,
          allDayMinsBefore: notification.allDayMinsBefore,
          timedMinsBefore: notification.timedMinsBefore,
          timezone: tz,
          signEvent,
          publishEvent,
          nip44: signer!.nip44,
        });
        if (mounted) {
          pushPublished.current = pushKey;
          log.info("push subscription published");
        }
      } catch (err) {
        if (mounted) log.warn("push registration failed", err);
      }
    })();
    return () => { mounted = false; };
  }, [pubkey, notification, signEvent, publishEvent, signer]);
}
