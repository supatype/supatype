/**
 * Brings a running compose stack's functions worker up to date with the hooks module a push wrote.
 *
 * The worker imports every handler once, when it starts. A stack brought up before the first push
 * started it before `hooks/_supatype/hooks.ts` existed, so each hook failed to load and the writes
 * to its table answered 503 until somebody restarted the worker. `dev` restarts it on a save
 * (dev-functions-watch.ts); a push from a plain terminal is the other way the file appears.
 */
import { restartComposeFunctionsWorker, type ComposeWorkerTarget } from "./dev-functions-watch.js"
import { enterLocalStack } from "./dev-session-lock.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { selfHostComposePaths } from "./self-host-compose.js"

/** Restarts the stack's worker when the push `written` changed the hooks module; no-op otherwise. */
export async function reloadHooksWorker(
  cwd: string,
  config: SupatypeProjectConfig,
  written: { hooksModuleWritten: boolean },
  stack: { baseUrl: string; anonKey: string | undefined },
  restart: (target: ComposeWorkerTarget) => Promise<void> = (target) =>
    restartComposeFunctionsWorker(target, undefined, "The hook handler types were written"),
): Promise<void> {
  if (!written.hooksModuleWritten) return
  const project = enterLocalStack(cwd, config.project.name)
  await restart({ composePath: selfHostComposePaths(cwd).composePath, cwd, project, ...stack })
}
