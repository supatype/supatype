import { execFile, type ExecFileException } from "node:child_process"

/** How a program's run ended, in the terms `spawnSync` reported it in. */
export interface CapturedRun {
  /** Exit status; null when it did not exit on its own (killed, or could not start). */
  status: number | null
  stdout: string
  stderr: string
  /** Why it could not run, when it could not. */
  error?: string
}

/** Where a run happens. */
export interface CapturedRunPlace {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** The most output a run may give: the engine's admin config and generated types run to megabytes. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

function exitStatus(err: ExecFileException | null): number | null {
  if (err === null) return 0
  return typeof err.code === "number" ? err.code : null
}

/**
 * Runs `bin` without a shell and resolves with how it ended; never rejects. Asynchronous, so the dev
 * dashboard and every process dev runs keep going meanwhile: run through `spawnSync`, each engine
 * call held all of them for as long as a schema push took.
 */
export function runCaptured(bin: string, args: readonly string[], place: CapturedRunPlace = {}): Promise<CapturedRun> {
  const options = { encoding: "utf8" as const, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, ...place }
  return new Promise((resolve) => {
    execFile(bin, [...args], options, (err, stdout, stderr) => {
      const failedToRun = err !== null && typeof err.code !== "number"
      resolve({ status: exitStatus(err), stdout, stderr, ...(failedToRun && { error: err.message }) })
    })
  })
}
