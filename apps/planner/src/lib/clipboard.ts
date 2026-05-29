/**
 * Copy text to the clipboard with a legacy fallback.
 *
 * `navigator.clipboard` is undefined in non-secure contexts and can reject in
 * some webviews (notably installed PWAs / Tauri on certain platforms). When it
 * isn't available or throws, fall back to the legacy `execCommand("copy")` via
 * a hidden textarea. Returns whether the copy actually succeeded so callers can
 * surface a "copy failed — select manually" affordance instead of silently
 * appearing dead.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
