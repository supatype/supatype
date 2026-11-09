/**
 * Run one seed module and take the document it described.
 *
 * In a child process, which is how this CLI already evaluates a project's TypeScript: a seed is
 * the user's code and should not share a process with the tool running it. Under Node the child
 * runs through tsx. The standalone binary interprets TypeScript itself, so it runs itself.
 *
 * The document comes back through a file rather than stdout, because a seed is allowed to
 * print. Mixing its output into the channel carrying the document would mean a `log()` call
 * could corrupt the IR.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliModuleUrl, evalTsSnippet, runSelf, type RunResult } from "./tsx-runner.js"
import { isCompiledBinary } from "./cli-install-method.js"
import type { SeedJob } from "./seed-child.js"
import type { SeedConfig, SeedIr } from "./seed.js"
import { isArrayOf, isBoolean, isJsonObject, isShape, isString, optional } from "@supatype/shared"

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

const isSeedConfig = isShape({ runOnce: optional(isBoolean) })

/** What a seed file's `config` may set. */
const SEED_CONFIG_KEYS: readonly string[] = ["runOnce"]

/**
 * A `config` key the runner does not read is refused rather than ignored, so a typo (`runonce`) or a
 * setting that does nothing is not a promise silently not kept. `transaction` gets its own reason:
 * the engine runs every seed document in a transaction and cannot run one outside it.
 */
function refuseUnknownConfig(file: string, collected: unknown): void {
  const config = isJsonObject(collected) ? collected["config"] : undefined
  if (!isJsonObject(config)) return
  const unknown = Object.keys(config).filter((key) => !SEED_CONFIG_KEYS.includes(key))
  if (unknown.length === 0) return
  if (unknown.includes("transaction")) {
    throw new Error(
      `${file}: \`config.transaction\` is not supported. Every seed file runs in a transaction of its ` +
        "own (all of them in one with `supatype seed --atomic`). Remove `transaction` from its `config`.",
    )
  }
  throw new Error(
    `${file}: \`config\` sets ${unknown.join(", ")}, which a seed file cannot. It may set: ${SEED_CONFIG_KEYS.join(", ")}.`,
  )
}

/** The IR's header, and that each operation names its `op`. */
const isIrHeader = isShape({
  irVersion: (value: unknown): value is 1 => value === 1,
  schemaFingerprint: isString,
  operations: isArrayOf(isShape({ op: isString })),
})

/**
 * What the child this module spawns wrote: the seed module's shape, the collector's document and
 * the module's `config`. The header and the config are checked here; the operations are the
 * collector's own output (`SeedCollector.finish`), each checked to name its `op`, and the engine
 * validates every one before anything runs.
 */
function isCollected(value: unknown): value is Collected {
  if (!isJsonObject(value)) return false
  if (value["shape"] === "legacy") return true
  return value["shape"] === "collected" && isIrHeader(value["ir"]) && isSeedConfig(value["config"])
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
    const job: SeedJob = {
      file,
      outPath,
      builderPath: options.builderPath,
      ...(options.environment !== undefined && { environment: options.environment }),
    }
    const run = runSeedChild(job, options.cwd)
    if (run.exitCode !== 0 || !existsSync(outPath)) {
      throw new SeedCollectionFailed(file, [run.stdout, run.stderr].filter(Boolean).join("\n").trim())
    }
    const result: unknown = JSON.parse(readFileSync(outPath, "utf8"))
    refuseUnknownConfig(file, result)
    if (!isCollected(result)) throw new SeedCollectionFailed(file, "The seed module's collected document could not be read")
    return { result, stdout: run.stdout }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Run `collectSeedHere` for `job` in a child process.
 *
 * Under Node, a snippet run through tsx imports it by its path. The standalone binary runs
 * `_collect-seed` on itself, because its own modules are not importable from a snippet.
 */
function runSeedChild(job: SeedJob, cwd: string): RunResult {
  if (isCompiledBinary()) return runSelf(["_collect-seed", JSON.stringify(job)], { cwd })
  const child = JSON.stringify(cliModuleUrl("seed-child.js"))
  return evalTsSnippet(`import { collectSeedHere } from ${child}\nawait collectSeedHere(${JSON.stringify(job)})\n`, { cwd })
}
