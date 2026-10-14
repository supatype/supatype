/**
 * Which mode a re-render of the compose file uses, decided one way for every command (SH1, SH2).
 *
 * The file has two modes. Dev turns on what a laptop wants and a server must not have: every origin
 * allowed by CORS, Studio open without a login (`STUDIO_OPEN_DEV`), the database on a loopback dev
 * port. Standalone is the production stack `supatype self-host compose up` starts. Commands used to
 * pick a mode by who they were: everything `push`, `diff` or `adopt` touched rendered dev, so a push
 * to a production stack re-rendered it as dev and `up -d` recreated it that way; and every
 * `self-host compose` command rendered standalone, so restarting one service of a `supatype dev`
 * stack turned that service into production. The rule now looks at the stack instead:
 *
 * 1. a `supatype dev` session holds the project's lock: dev;
 * 2. otherwise, a server container is running: the mode it is running in;
 * 3. otherwise: standalone, the safe one.
 *
 * `supatype dev` itself is the one caller that does not ask: it is what makes a stack dev.
 */

import { spawnSync } from "node:child_process"
import { readDevSessionLock } from "./dev-session-lock.js"
import { composeProjectName } from "./self-host-compose.js"

export type ComposeRenderMode = "dev" | "standalone"

/** What the rule reads from the machine, so a test can stand in for each. */
export interface ComposeRenderModeProbe {
  /** True when a `supatype dev` session's lock is held for the project at `cwd`. */
  devSessionLocked: (cwd: string) => boolean
  /** The mode the compose project's running server container is in, or undefined if none runs. */
  runningServerMode: (composeProject: string) => ComposeRenderMode | undefined
}

/** `SUPATYPE_MODE` from a running server container's environment, as the render wrote it. */
function runningServerModeFromDocker(composeProject: string): ComposeRenderMode | undefined {
  const listed = spawnSync(
    "docker",
    [
      "ps", "-q",
      "--filter", `label=com.docker.compose.project=${composeProject}`,
      "--filter", "label=com.docker.compose.service=server",
    ],
    { encoding: "utf8" },
  )
  const id = listed.status === 0 ? listed.stdout.trim().split(/\s+/)[0] : undefined
  if (!id) return undefined
  const inspected = spawnSync(
    "docker",
    ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", id],
    { encoding: "utf8" },
  )
  if (inspected.status !== 0) return undefined
  const mode = inspected.stdout.split(/\r?\n/).find((line) => line.startsWith("SUPATYPE_MODE="))
  return mode === "SUPATYPE_MODE=dev" ? "dev" : "standalone"
}

/**
 * Set by `supatype dev` for its own process. Its lock file is written only once the stack is up,
 * because scripts wait for that file as the sign dev is ready, so until then the session is known
 * here rather than on disk, and every render dev makes on the way up stays dev.
 */
let devSessionInThisProcess = false

/** Mark this process as a `supatype dev` session: its renders are dev from now on. */
export function claimDevRenderMode(): void {
  devSessionInThisProcess = true
}

const liveProbe: ComposeRenderModeProbe = {
  devSessionLocked: (cwd) => devSessionInThisProcess || readDevSessionLock(cwd) !== null,
  runningServerMode: runningServerModeFromDocker,
}

/** The mode a render for the project `projectName` at `cwd` should use (see the module comment). */
export function composeRenderMode(
  cwd: string,
  projectName: string,
  probe: ComposeRenderModeProbe = liveProbe,
): ComposeRenderMode {
  if (probe.devSessionLocked(cwd)) return "dev"
  return probe.runningServerMode(composeProjectName(projectName)) ?? "standalone"
}

/** `composeRenderMode` as the render options take it. */
export function composeRenderOptions(
  cwd: string,
  projectName: string,
  probe: ComposeRenderModeProbe = liveProbe,
): { devLocal: boolean } {
  return { devLocal: composeRenderMode(cwd, projectName, probe) === "dev" }
}
