/**
 * What `bin/supatype.js` runs when the CLI is installed from npm: the compiled program for this
 * machine, downloaded once per version from the release CDN, and never the CLI's JavaScript.
 *
 * The CLI draws its screens with Ink, which renders through React. Installed as JavaScript, its
 * dependencies were hoisted into the app's `node_modules`, where Ink found the app's React rather
 * than its own; with React 19 every command failed at startup. The compiled program carries its own
 * copy of everything it runs, so nothing the app installs can reach it.
 *
 * This runs before every command, so a cached program is started having loaded nothing but Node's
 * own modules and a few small ones. The download code is loaded only when there is something to
 * download. tests/package-runtime-imports.test.ts holds what it loads to the package's dependencies.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { constants } from "node:os"
import type { PlatformId } from "./binary-cache.js"
import { oldVersionsNotice } from "./cli-old-versions.js"
import { cliCachePath, publishedTarget } from "./cli-program-path.js"
import { EMBEDDED_CLI_VERSION } from "./cli-version-embedded.js"
import { STOP_SIGNALS } from "./stop-signals.js"

/** The cached program for `version`, downloaded and verified first if it is not there yet. */
export async function ensureCliProgram(version: string, platform: PlatformId): Promise<string> {
  const cached = cliCachePath(version, platform)
  if (existsSync(cached)) return cached
  process.stderr.write(`[supatype] Downloading the Supatype CLI v${version}. This happens once per version.\n`)
  const { downloadStandaloneCli } = await import("./cli-standalone.js")
  try {
    return await downloadStandaloneCli(version, platform)
  } catch (err) {
    throw new Error(
      `Could not download the Supatype CLI v${version}: ${messageOf(err)}\n` +
        "The first run of each version fetches it from releases.supatype.com. " +
        "To use a mirror of that site, set SUPATYPE_CDN_BASE to its address.",
    )
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Whether the starter passes `signal` on. On Linux and macOS every stop signal is: one sent to the
 * starter alone, as an IDE's stop button or a supervisor sends it, would otherwise never reach the
 * program. A Ctrl+C typed in the terminal reaches the program as well, so it gets that one twice,
 * milliseconds apart, and `supatype dev` counts the pair as one press (dev-shutdown.ts).
 *
 * On Windows none is: the console delivers Ctrl+C, Ctrl+Break and a closed window to every process
 * attached to it, the program included, and `kill` there ends the program at once, skipping its
 * shutdown, or for SIGHUP and SIGBREAK throws. A starter ended outright takes the program with it:
 * on Windows Node ends the processes it started when it is ended, as ending the CLI itself did
 * before it had a starter.
 */
function forwardedSignal(): boolean {
  return process.platform !== "win32"
}

/** Exit codes and signals that `program` ended with, passed on as this process's own. */
export function runCliProgram(program: string, args: string[]): Promise<number> {
  const child = spawn(program, args, { stdio: "inherit" })
  // Every stop signal is listened for, so none ends the starter and leaves the program running.
  const handlers = STOP_SIGNALS.map((signal) => {
    const handler = forwardedSignal() ? () => child.kill(signal) : () => {}
    process.on(signal, handler)
    return [signal, handler] as const
  })
  const release = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
  return new Promise((resolve, reject) => {
    child.once("error", (err) => {
      release()
      reject(err)
    })
    child.once("exit", (code, signal) => {
      release()
      resolve(code ?? 128 + (signal !== null ? constants.signals[signal] : 1))
    })
  })
}

/** The version this package was released as. Only a source build leaves it empty. */
async function packageVersion(): Promise<string> {
  if (EMBEDDED_CLI_VERSION !== "") return EMBEDDED_CLI_VERSION
  return (await import("./cli-package-version.js")).cliPackageVersion()
}

/**
 * Before the program starts, so it never lands in the middle of a screen the program draws. A
 * notice is never worth a failed command, so a cache it cannot read or write is skipped.
 */
function noticeOldVersions(running: string): void {
  try {
    const notice = oldVersionsNotice(running)
    if (notice !== undefined) process.stderr.write(`${notice}\n`)
  } catch {
    // Nothing to say, then.
  }
}

/** Runs this package's version of the program with `args`, and exits with its status. */
export async function run(args: string[] = process.argv.slice(2)): Promise<never> {
  try {
    const version = await packageVersion()
    const program = await ensureCliProgram(version, publishedTarget())
    noticeOldVersions(version)
    process.exit(await runCliProgram(program, args))
  } catch (err) {
    process.stderr.write(`${messageOf(err)}\n`)
    process.exit(1)
  }
}
