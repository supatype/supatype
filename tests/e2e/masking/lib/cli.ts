import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PROJECT_DIR } from "./stack.js"

/**
 * The CLI under test, run the way a user runs it. The runner names the build with MASKING_CLI
 * (the train's CLI, or this checkout's).
 */
export interface CliRun {
  status: number
  output: string
}

export function cliPath(): string {
  const path = process.env["MASKING_CLI"]
  if (path === undefined || path === "") throw new Error("MASKING_CLI must name the CLI's bin/supatype.js")
  return path
}

export function runCli(args: string[], cwd: string = PROJECT_DIR, timeoutMs = 180_000): CliRun {
  const run = spawnSync(process.execPath, [cliPath(), ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 16 * 1024 * 1024,
  })
  return { status: run.status ?? 1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` }
}

/** The project's database as the host reaches it, from the DATABASE_URL `supatype dev` wrote. */
export function hostDatabaseUrl(): string {
  const env = readFileSync(join(PROJECT_DIR, ".env"), "utf8")
  const url = /^DATABASE_URL=(.*)$/m.exec(env)?.[1]?.trim()
  if (url === undefined || url === "") throw new Error(`DATABASE_URL is missing from ${PROJECT_DIR}/.env`)
  return url.replace("@localhost:", "@127.0.0.1:")
}
