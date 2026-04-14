/**
 * Planner Push Notification Daemon
 *
 * Connects to Nostr relays, watches for push data and subscription
 * events encrypted to this bot's pubkey. Sends real-time Web Push
 * notifications before events start. Optionally serves a CalDAV/iCal
 * feed of public calendar events.
 */

import { loadConfig } from "./config.js";
import { createPool } from "./relay.js";
import { UserRegistry } from "./digest.js";
import { initWebPush, sendPushNotification } from "./push.js";
import { startCaldavServer } from "./caldav.js";

async function main() {
  const config = loadConfig();
  console.log(`[daemon] bot pubkey: ${config.botPubkey}`);
  console.log(`[daemon] relays: ${config.relays.join(", ")}`);

  // Initialize Web Push
  initWebPush(config);

  // Connect to relays
  const pool = createPool(config.relays);

  // Build user registry from existing events
  const registry = new UserRegistry(config.botPrivkey, config.botPubkey);
  await registry.loadFromRelays(pool);

  // Subscribe to live updates — reconnects automatically on relay drop.
  let shutdownRequested = false;
  const liveSubLoop = (async () => {
    let backoffMs = 5_000;
    while (!shutdownRequested) {
      try {
        console.log("[daemon] subscribing to live events...");
        const sub = pool.req([{
          kinds: [30078],
          "#p": [config.botPubkey],
        }]);
        backoffMs = 5_000; // reset backoff on successful connect
        for await (const msg of sub) {
          if (msg[0] === "EVENT") {
            try {
              registry.processEvent(msg[2]);
            } catch (err) {
              console.error(`[daemon] failed to process event ${(msg[2] as { id?: string }).id?.slice(0, 8) ?? "?"}:`, err);
            }
          }
        }
        // Iterator ended cleanly (relay closed normally)
        if (!shutdownRequested) {
          console.warn("[daemon] subscription ended, reconnecting in 5s...");
          await new Promise(r => setTimeout(r, 5_000));
        }
      } catch (err) {
        if (!shutdownRequested) {
          console.error(`[daemon] subscription error, reconnecting in ${backoffMs / 1000}s:`, err);
          await new Promise(r => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 60_000); // exponential backoff, max 60s
        }
      }
    }
  })();

  // ── Push notification check (every N seconds) ───────────────────────

  const pushIntervalMs = config.pushCheckIntervalSecs * 1000;
  console.log(`[daemon] push check every ${config.pushCheckIntervalSecs}s`);

  // Concurrency guard: prevent duplicate push notifications if check is slow
  let pushRunning = false;

  async function checkPushNotifications() {
    if (pushRunning) return;
    pushRunning = true;
    try {
      const pending = registry.getPendingPushNotifications(config.maxStaleHours);
      if (pending.length === 0) return;

      for (const { user, sub, event } of pending) {
        // Key format must match getPendingPushNotifications dedup key exactly
        const eventKey = `${event.start}\x00${event.title}\x00${event.location ?? ""}`;

        const ok = await sendPushNotification(sub, event);
        if (ok) {
          registry.markPushSent(sub, eventKey);
        } else {
          // Subscription expired — remove it
          console.log(`[daemon] removing expired push sub for ${user.pubkey.slice(0, 8)}`);
          registry.removePushSub(user.pubkey, sub.endpoint);
        }
      }
    } finally {
      pushRunning = false;
    }
  }

  // Initial check
  await checkPushNotifications();

  // Recurring check
  const pushTimer = setInterval(checkPushNotifications, pushIntervalMs);

  // Start CalDAV iCal feed server (if configured)
  const caldavServer = startCaldavServer(config, pool);

  // Graceful shutdown: stop accepting new work, drain in-flight operations, then exit.
  async function shutdown(signal: string) {
    console.log(`[daemon] received ${signal}, shutting down...`);
    shutdownRequested = true;
    clearInterval(pushTimer);
    caldavServer?.close();

    // Wait for any in-flight push sends to complete (up to 30 s).
    const drainDeadline = Date.now() + 30_000;
    while (pushRunning && Date.now() < drainDeadline) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (pushRunning) {
      console.warn("[daemon] drain timeout — some operations may not have completed");
    }

    await pool.close().catch(() => {});
    await liveSubLoop.catch(() => {});
    console.log("[daemon] shutdown complete");
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log("[daemon] running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
