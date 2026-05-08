/**
 * Debug logging utility — logs only when DEBUG is enabled.
 * Enable in browser console: localStorage.setItem('debug', '1')
 * Or set VITE_DEBUG=1 in environment.
 */

const DEBUG_ENABLED =
  typeof window !== "undefined" &&
  (localStorage.getItem("debug") === "1" ||
   (import.meta as any).env?.VITE_DEBUG === "1" ||
   (import.meta as any).env?.DEV);

export function debug(...args: any[]) {
  if (DEBUG_ENABLED) {
    console.log("[debug]", ...args);
  }
}

export function debugError(...args: any[]) {
  if (DEBUG_ENABLED) {
    console.error("[debug]", ...args);
  }
}

export function debugWarn(...args: any[]) {
  if (DEBUG_ENABLED) {
    console.warn("[debug]", ...args);
  }
}
