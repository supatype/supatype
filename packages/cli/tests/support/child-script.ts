import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** The native Postgres the CLI caches, which tests that need a real cluster run; absent on most machines. */
export const CACHED_PG_BIN = join(homedir(), ".supatype", "cache", "postgres", "17.2.10", "pg-17.2.10", "bin")

/** A `src/` module of the CLI as an import specifier a script in another directory can use. */
export function cliModule(name: string): string {
  return JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "..", "src", name)).href)
}

/**
 * Runs `lines` as the body of an async ES module script in a Node process of its own (with tsx, so
 * it can import the CLI's TypeScript), as `supatype dev` runs: its own signals, its own exit. Resolves
 * with its exit code and everything it wrote, stdout and stderr together.
 */
export async function runScriptInChild(lines: readonly string[]): Promise<{ code: number | null; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "supatype-child-script-"))
  try {
    const script = join(dir, "script.mjs")
    writeFileSync(script, ["void (async () => {", ...lines.map((line) => `  ${line}`), "})()", ""].join("\n"))
    const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: join(import.meta.dirname, "..", ".."), stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d: Buffer) => (out += d.toString()))
    child.stderr.on("data", (d: Buffer) => (out += d.toString()))
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
    return { code, out }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
