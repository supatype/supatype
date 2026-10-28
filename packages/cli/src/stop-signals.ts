/**
 * The signals that ask a long-running command to stop: Ctrl+C, a stop request, a closed terminal
 * (the console window on Windows, a hung-up terminal elsewhere), and Ctrl+Break on Windows.
 * `dev` and `functions serve` both listen for these, so a signal added here reaches both.
 */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  ...(process.platform === "win32" ? ["SIGBREAK" as const] : []),
]
