/**
 * The worker exits when it is told to stop. In its container it runs as PID 1, and PID 1 gets no
 * default action for SIGTERM or SIGINT: with no handler, `docker restart` and `docker stop` waited
 * out the whole stop timeout (10 s) before killing it, so every self-host deploy that restarted the
 * worker took more than ten seconds. The compose file also gives it an init (`init: true`).
 */

/** What stopping needs of Deno, replaceable in tests. */
export interface StopHooks {
  os: string
  addSignalListener(signal: "SIGTERM" | "SIGINT", handler: () => void): void
  exit(code: number): void
}

const DENO_HOOKS: StopHooks = {
  os: Deno.build.os,
  addSignalListener: (signal, handler) => Deno.addSignalListener(signal, handler),
  exit: (code) => Deno.exit(code),
}

/**
 * Exits at once on SIGTERM and SIGINT. Not on Windows, where Deno takes no SIGTERM listener and a
 * process is stopped some other way.
 */
export function exitOnStop(hooks: StopHooks = DENO_HOOKS): void {
  if (hooks.os === "windows") return
  for (const signal of ["SIGTERM", "SIGINT"] as const) hooks.addSignalListener(signal, () => hooks.exit(0))
}
