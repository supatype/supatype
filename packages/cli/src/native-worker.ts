/**
 * The functions worker native dev's server runs, set up on every start, whether or not the project
 * has a function or a hook yet.
 *
 * The server reads its functions settings once, at spawn: it mounts /functions/v1 and starts Deno
 * only when it is given a functions directory. Native dev used to give it one only when functions/
 * or hooks/ existed, so in a project with neither (as `init` makes one) the first hook declared
 * while dev ran made every write to its table answer 503, and the first function 404, until dev was
 * restarted (local test round 3d, N19). Now the worker always runs, on the directories the project
 * would have; the worker takes a root that is not there yet as one with no routes. A route added
 * later rewrites the entry (native-functions-watch.ts), and Deno's watch reloads the worker.
 *
 * The cost of always running it, measured on Windows with Deno 2.2: two processes and about 54 MB
 * at rest, ready in about half a second, and Deno downloaded once on a project's first dev.
 */
import { spawnSync } from "node:child_process"
import { relative } from "node:path"
import { cachedVersionOf } from "./binary-cache.js"
import { ensureBinary } from "./ensure-binary.js"
import { errorMessage } from "./error-message.js"
import { installFunctionsWorker, localWorkerRoutesOrExit, writeDevFunctionsEntry } from "./functions-worker-files.js"
import { hooksPathFromProject, preferredFunctionsPathFromProject, type SupatypeProjectConfig } from "./project-config.js"

/** What native dev's server runs its functions worker from. */
export interface NativeWorker {
  /** The functions directory, there or not. */
  functionsDir: string
  /** The hooks directory, there or not. */
  hooksDir: string
  /** The worker's main.ts, in the CLI's cache. */
  workerMain: string
  /** The entry the server runs Deno on, importing the worker and naming its routes. */
  entry: string
  routes: string[]
  /** Deno, or undefined when it could not be provisioned: then nothing runs functions or hooks. */
  denoBin: string | undefined
}

/** Sets up the worker for this start: see the file's comment. */
export async function prepareNativeWorker(cwd: string, config: SupatypeProjectConfig): Promise<NativeWorker> {
  const functionsDir = preferredFunctionsPathFromProject(config, cwd)
  const hooksDir = hooksPathFromProject(config, cwd)
  const routes = localWorkerRoutesOrExit(functionsDir, hooksDir)
  const workerMain = installFunctionsWorker()
  const entry = writeDevFunctionsEntry(cwd, routes, workerMain, hooksDir)
  const denoBin = await provisionDeno(config)
  const served = routes.length > 0
    ? `${routes.length} route(s): ${routes.join(", ")}`
    : "no functions or hooks yet; one added while dev runs is served"
  console.log(`[supatype] Edge functions worker: ${relative(cwd, entry)} (${served})`)
  return { functionsDir, hooksDir, workerMain, entry, routes, denoBin }
}

/**
 * What the server is told about Deno. Unset, its default is `deno` from PATH, so a dev whose Deno
 * could not be provisioned ran another one while its routes said functions were off (local test
 * round 5, N25). Empty runs none.
 */
export function nativeWorkerDenoEnv(worker: Pick<NativeWorker, "denoBin">): { SUPATYPE_DENO_PATH: string } {
  return { SUPATYPE_DENO_PATH: worker.denoBin ?? "" }
}

/**
 * Deno, fetched on first use, or undefined, said why, when it cannot be. Its version is read from
 * the binary found: asking the CDN for it again, when the cached one was found because the CDN
 * failed, turned functions off (N25).
 */
async function provisionDeno(config: SupatypeProjectConfig): Promise<string | undefined> {
  try {
    const denoBin = await ensureBinary("deno", config)
    const version = cachedVersionOf("deno", denoBin)
    console.log(`[supatype] Deno runtime: ${denoBin}${version !== undefined ? ` (v${version})` : ""}`)
    return denoBin
  } catch (err) {
    console.warn(
      "[supatype] ⚠  Could not provision Deno, so edge functions and model hooks will not run.\n" +
        `  ${errorMessage(err)}\n` +
        "  (Functions still appear in Studio; invocations need Deno.)",
    )
    return undefined
  }
}

/** What a preflight run of Deno answered. */
export interface DenoRun {
  status: number | null
  stdout: string
  stderr: string
}

function runDenoInFolder(denoBin: string, cwd: string): DenoRun {
  const result = spawnSync(denoBin, ["eval", "0"], { cwd, stdio: "pipe", encoding: "utf8", timeout: 30_000, windowsHide: true })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/**
 * Why Deno cannot start in the project folder, as a warning, or null when it can.
 *
 * The server starts Deno for the worker and keeps its output to itself, so a Deno that fails at
 * once (one older than the `deno.lock` beside it: "Failed reading lockfile") left every function
 * answering 502 with an empty body and nothing in dev's output (0.9.3 run). `deno eval 0` reads
 * the folder's config and lockfile as the worker does, in about a second and with no downloads.
 */
export function denoPreflightWarning(
  denoBin: string | undefined,
  cwd: string,
  run: (denoBin: string, cwd: string) => DenoRun = runDenoInFolder,
): string | null {
  if (denoBin === undefined) return null
  const answer = run(denoBin, cwd)
  if (answer.status === 0) return null
  // Deno colours its errors; the warning is read in a log too.
  const detail = `${answer.stderr}${answer.stdout}`.replace(/\u001b\[[0-9;]*m/g, "").trim()
  const lines = detail.split(/\r?\n/).map((line) => `  ${line}`).join("\n")
  return (
    "[supatype] ⚠  Deno cannot start in this folder, so every edge function and model hook will answer 502:\n" +
    `${lines}\n` +
    "  A deno.lock written by a newer Deno is the usual cause: delete it, or pin that Deno in versions.deno."
  )
}
