/**
 * Run one seed module and take the document it described.
 *
 * In a child process, through tsx, which is how this CLI already evaluates a project's
 * TypeScript. Two reasons beyond consistency: a seed is the user's code and should not share
 * a process with the tool running it, and the same route works for the standalone binary,
 * which interprets TypeScript itself rather than resolving tsx from a `node_modules` it does
 * not have.
 *
 * The document comes back through a file rather than stdout, because a seed is allowed to
 * print. Mixing its output into the channel carrying the document would mean a `log()` call
 * could corrupt the IR.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { evalTsSnippet } from "./tsx-runner.js"
import type { SeedConfig, SeedIr } from "./seed.js"

/** What a seed module turned out to be. */
export type Collected =
  | {
      shape: "collected"
      ir: SeedIr
      config: SeedConfig
    }
  | {
      /**
       * The old contract: no default export, so importing it did the work.
       *
       * Every existing project is this shape and keeps working. Nothing here removes it.
       */
      shape: "legacy"
    }

export interface CollectOptions {
  cwd: string
  /** The generated builder, for the manifest and the schema fingerprint. */
  builderPath: string
  environment?: string | undefined
}

export class SeedCollectionFailed extends Error {
  constructor(
    readonly file: string,
    readonly output: string,
  ) {
    super(`${file} failed while it was being read:\n${output}`)
    this.name = "SeedCollectionFailed"
  }
}

/** Import `file`, run its default export against a collector, and return what it described. */
export function collectSeed(file: string, options: CollectOptions): { result: Collected; stdout: string } {
  const scratch = mkdtempSync(join(tmpdir(), "supatype-seed-"))
  const outPath = join(scratch, "ir.json")

  try {
    const run = evalTsSnippet(snippet(file, outPath, options), { cwd: options.cwd })
    if (run.exitCode !== 0 || !existsSync(outPath)) {
      throw new SeedCollectionFailed(file, [run.stdout, run.stderr].filter(Boolean).join("\n").trim())
    }
    const result = JSON.parse(readFileSync(outPath, "utf8")) as Collected
    return { result, stdout: run.stdout }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The program that runs in the child.
 *
 * Every path is interpolated as a JSON string rather than pasted in, because a Windows path
 * is full of backslashes and a project directory is allowed to contain a quote.
 */
function snippet(file: string, outPath: string, options: CollectOptions): string {
  const url = (path: string): string => JSON.stringify(pathToFileURL(path).href)
  return `
import { writeFileSync } from "node:fs"
import { SeedCollector } from "./seed-ir.js"
import { expr } from "./seed.js"

const builder = await import(${url(options.builderPath)})
const module = await import(${url(file)})

if (typeof module.default !== "function") {
  // Importing it is what ran it, which is the old contract working exactly as it did.
  writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({ shape: "legacy" }))
} else {
  const collector = new SeedCollector(builder.schemaFingerprint, builder.seedModels)
  await module.default({
    db: collector.db(),
    expr,
    log: (message) => { console.log(message) },
    environment: ${options.environment === undefined ? "undefined" : JSON.stringify(options.environment)},
  })
  writeFileSync(
    ${JSON.stringify(outPath)},
    JSON.stringify({
      shape: "collected",
      ir: collector.finish().ir,
      config: module.config ?? {},
    }),
  )
}
`
}
