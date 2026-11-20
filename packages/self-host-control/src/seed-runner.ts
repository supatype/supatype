import { writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { isJsonObject } from "@supatype/shared"
import { EngineRunError, runEngine } from "./engine-runner.js"

/**
 * Seeds through the engine binary.
 *
 * The database URL goes to the engine in its environment (`DATABASE_URL`, which every subcommand
 * that connects reads), never on its command line, where `ps` shows it to anyone on the host.
 */

/** Default time an engine may run before it is killed, below the gateway's own request timeout. */
export const SEED_TIMEOUT_MS = 120_000

/** The kill timer: `SUPATYPE_SEED_TIMEOUT_MS` when set to a positive number, else the default. */
export function seedTimeoutMs(): number {
  const configured = Number(process.env["SUPATYPE_SEED_TIMEOUT_MS"])
  return Number.isFinite(configured) && configured > 0 ? configured : SEED_TIMEOUT_MS
}

export interface SeedRunOptions {
  atomic: boolean
  runOnce: boolean
  /** The name a seed's `environment` condition reads. */
  environment: string
  timeoutMs: number
}

/** The engine ran but its answer cannot be used. */
export class SeedEngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedEngineError"
  }
}

/**
 * `text` with the database URL, its password and the password of any connection string removed.
 * An engine's error text can repeat the URL it was given.
 */
export function redactCredentials(text: string, databaseUrl: string): string {
  const password = passwordOf(databaseUrl)
  const withoutUrl = text.split(databaseUrl).join("***")
  const withoutPassword = password === "" ? withoutUrl : withoutUrl.split(password).join("***")
  return withoutPassword.replace(/(:\/\/[^:/@\s]+:)[^@\s]*(@)/g, "$1***$2")
}

function passwordOf(databaseUrl: string): string {
  try {
    return decodeURIComponent(new URL(databaseUrl).password)
  } catch {
    return ""
  }
}

/** The JSON object an engine printed: the whole of stdout, or failing that its last JSON line. */
function resultOf(stdout: string): unknown {
  const candidates = [stdout.trim(), ...stdout.split(/\r?\n/).reverse().map((line) => line.trim())]
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isJsonObject(parsed)) return parsed
    } catch {
      /* not this one */
    }
  }
  return undefined
}

/** Exit 1 (the seed did not apply) and 2 (it could not start) with a JSON result are answers. */
async function answerOf(run: Promise<string>): Promise<unknown> {
  let stdout: string
  try {
    stdout = await run
  } catch (err) {
    if (err instanceof EngineRunError && (err.exitCode === 1 || err.exitCode === 2)) {
      const result = resultOf(err.stdout)
      if (result !== undefined) return result
    }
    throw err
  }
  const result = resultOf(stdout)
  if (result === undefined) throw new SeedEngineError("The engine finished without printing a seed result")
  return result
}

async function writeText(path: string, text: string): Promise<void> {
  await writeFile(path, text, "utf-8")
}

async function removeAll(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => unlink(path).catch(() => {})))
}

/** Seed `documents` (each written byte for byte, so the engine's run-once hash matches the CLI's). */
export async function runEngineSeed(
  databaseUrl: string,
  ast: unknown,
  documents: readonly string[],
  opts: SeedRunOptions,
): Promise<unknown> {
  const stem = join(tmpdir(), `supatype-seed-${randomUUID()}`)
  const astPath = `${stem}-ast.json`
  const irPaths = documents.map((_, index) => `${stem}-ir-${index}.json`)
  try {
    await writeText(astPath, JSON.stringify(ast))
    await Promise.all(irPaths.map((path, index) => writeText(path, documents[index] ?? "")))
    const args = [
      ...irPaths.flatMap((path) => ["--ir", path]),
      "--environment", opts.environment,
      ...(opts.atomic ? ["--atomic"] : []),
      ...(opts.runOnce ? ["--run-once"] : []),
    ]
    return await answerOf(
      runEngine("seed", args, { inputPath: astPath, databaseUrl, timeoutMs: opts.timeoutMs }),
    )
  } finally {
    await removeAll([astPath, ...irPaths])
  }
}

/** `seed --status`: what has been applied, and what has changed since. It needs no schema. */
export async function runEngineSeedStatus(databaseUrl: string, timeoutMs: number): Promise<unknown> {
  return answerOf(runEngine("seed", ["--status"], { databaseUrl, timeoutMs }))
}
