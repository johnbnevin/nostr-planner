/**
 * Cross-platform file save helper.
 *
 * Works identically on:
 *   - Web (desktop browsers): falls through to `<a download>` and the
 *     browser handles the Downloads folder.
 *   - Web (mobile PWA): tries the Web Share API first so the user gets
 *     the native share sheet (Save to Files / iCloud Drive on iOS,
 *     Drive / local on Android). Falls back to `<a download>` if share
 *     is unavailable or refuses the file type.
 *   - Tauri desktop / mobile: same as web — Tauri's WebView2 and
 *     WKWebView honor both APIs. We avoid the @tauri-apps/plugin-dialog
 *     dependency so the bundle stays identical across builds.
 *
 * @module fileSave
 */
import { logger } from "./logger";

const log = logger("file-save");

/**
 * Save bytes to a user-chosen location.
 *
 * @param data     Either a string (will be encoded UTF-8) or a Blob.
 * @param filename Suggested filename (extension matters; the OS may use it).
 * @param mimeType MIME type. Used for the Blob and the share sheet hint.
 */
export async function saveFile(
  data: string | Blob,
  filename: string,
  mimeType = "application/octet-stream",
): Promise<void> {
  const blob = data instanceof Blob
    ? data
    : new Blob([data], { type: `${mimeType};charset=utf-8` });

  // Prefer the Web Share API on platforms that accept file shares —
  // this lights up the OS share sheet, which is the right UX on mobile
  // and is also pleasant on macOS desktop. Skip on desktops where
  // anchor-download is universally expected.
  const nav = (typeof navigator !== "undefined" ? navigator : null) as
    | (Navigator & { canShare?: (data: ShareData) => boolean })
    | null;
  const isMobileish = typeof window !== "undefined" &&
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator?.userAgent ?? "");
  if (isMobileish && nav?.canShare && nav.share) {
    try {
      const file = new File([blob], filename, { type: blob.type || mimeType });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      // User cancelled or share failed — fall through to download anchor.
      log.debug("share failed, falling back to download anchor:", err);
    }
  }

  // Anchor-download fallback. Works on every desktop browser, Tauri
  // WebView2/WKWebView, and most mobile browsers (iOS Safari is the one
  // exception; share above usually wins there).
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Revoke after a tick so the click had time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
