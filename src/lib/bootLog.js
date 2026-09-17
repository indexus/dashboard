/**
 * Sparse cold-start / Refresh diagnostics.
 *
 * Filter DevTools console with: indexus:boot
 * Disable:   globalThis.__INDEXUS_DEBUG_BOOT__ = false
 * Re-enable: globalThis.__INDEXUS_DEBUG_BOOT__ = true
 */
export function bootLog(event, detail) {
  try {
    if (globalThis.__INDEXUS_DEBUG_BOOT__ === false) return;
    if (detail !== undefined) {
      console.info(`[indexus:boot] ${event}`, detail);
    } else {
      console.info(`[indexus:boot] ${event}`);
    }
  } catch {
    /* ignore */
  }
}
