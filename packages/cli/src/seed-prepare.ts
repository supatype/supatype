/**
 * The half of `supatype seed` that does not depend on where the seeds go: find the files, collect
 * what each describes, and serialise the documents. The local arm hands the result to the engine
 * here and the remote arm to a control plane, and both must send the same text: the engine's
 * run-once ledger hashes it, so a difference would make a seed run twice.
 */

import { existsSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { toPosixPath } from "@supatype/shared"
import type { SupatypeConfig } from "./config.js"
import { errorMessage } from "./error-message.js"
import { projectRootFromConfig } from "./project-config.js"
import { connectAuthUsersByKey } from "./seed-auth-connect.js"
import { collectSeed } from "./seed-runner.js"
import { seedBuilderPathWithDefaults } from "./type-generation.js"
import type { ExtractedSchemaAstV2 } from "./schema-ast-v2.js"
import type { SeedConfig, SeedIr } from "./seed.js"
import { error, info, warn } from "./ui/messages.js"

const SEED_EXT = /\.(ts|mts|tsx)$/

/** Seed entries under `seeds/`, sorted by filename. */
export function discoverSeedsDir(cwd: string, seedsDir: string): string[] {
  if (!existsSync(seedsDir)) return []
  const names = readdirSync(seedsDir).filter((n) => SEED_EXT.test(n))
  names.sort((a, b) => a.localeCompare(b))
  return names.map((n) => join(seedsDir, n))
}

/** The seed files a run names: one, several in the order given, or none (the project's own). */
export type SeedFiles = string | readonly string[]

/** The seed files a run uses: the ones named, in that order, else every `seeds/*.ts`, else `seed.ts`. */
export function seedPaths(file: SeedFiles | undefined, cwd: string, config: SupatypeConfig): string[] {
  const named = (typeof file === "string" ? [file] : [...(file ?? [])]).filter((name) => name.trim() !== "")
  if (named.length > 0) return named.map((name) => resolve(cwd, name))
  const root = projectRootFromConfig(config, cwd)
  const fromDir = discoverSeedsDir(cwd, join(root, "seeds"))
  return fromDir.length > 0 ? fromDir : [resolve(root, "seed.ts")]
}

/** {@link seedPaths}, or undefined after reporting the ones that do not exist. */
export function existingSeedPaths(file: SeedFiles | undefined, cwd: string, config: SupatypeConfig): string[] | undefined {
  const paths = seedPaths(file, cwd, config)
  const missing = paths.filter((p) => !existsSync(p))
  if (missing.length === 0) return paths
  error(`Seed file(s) not found:\n  ${missing.join("\n  ")}`)
  return undefined
}

/** One file's worth of collected IR, with what that file asked for. */
export interface Prepared {
  file: string
  document: SeedIr
  config: SeedConfig
}

/** The path a file is shown and sent as: relative to the project, with forward slashes. */
export function seedLabel(cwd: string, path: string): string {
  return toPosixPath(relative(cwd, path))
}

/**
 * The generated builder, which the runtime needs for the manifest and the fingerprint.
 *
 * Absent is a setup problem with a one-line remedy rather than a crash: the builder is
 * gitignored by design, so a fresh clone that has not run `generate` is the ordinary case.
 */
export function locateBuilder(cwd: string, config: SupatypeConfig): string | undefined {
  const relativePath = seedBuilderPathWithDefaults(config.output)
  const path = resolve(cwd, relativePath)
  if (!existsSync(path)) {
    error(
      `The generated seed builder is missing: ${toPosixPath(relativePath)}\n` +
        "  Run `supatype generate`. It needs no database and no running stack.",
    )
    return undefined
  }
  return path
}

/** What collecting the files gave: the documents, and the files that had no default export. */
export type Collection =
  | { prepared: Prepared[]; legacy: string[] }
  | {
      /** The exit code of a run that could not collect. */
      failed: number
    }

export interface CollectContext {
  cwd: string
  builderPath: string
  /** What a seed's `environment` reads. */
  environment: string | undefined
}

/** Collect every file in a child process each, printing what each seed printed. */
export function collectPrepared(paths: readonly string[], context: CollectContext): Collection {
  const prepared: Prepared[] = []
  const legacy: string[] = []
  for (const path of paths) {
    const label = seedLabel(context.cwd, path)
    let collected
    try {
      collected = collectSeed(path, {
        cwd: context.cwd,
        builderPath: context.builderPath,
        environment: context.environment,
      })
    } catch (e) {
      error(errorMessage(e))
      return { failed: 1 }
    }

    if (collected.stdout.trim().length > 0) {
      for (const line of collected.stdout.trimEnd().split(/\r?\n/)) info(`  ${label}: ${line}`)
    }
    if (collected.result.shape === "legacy") {
      legacy.push(label)
      continue
    }
    prepared.push({ file: label, document: collected.result.ir, config: collected.result.config })
  }
  return { prepared, legacy }
}

/**
 * Each document as the exact text both arms send. `connectAuthUsersByKey` is the only rewrite, and
 * `file` is added last. The text is what the engine's ledger hashes, so it is made once, here.
 */
export function seedDocuments(prepared: readonly Prepared[], ast: ExtractedSchemaAstV2): string[] {
  return prepared.map((one) => JSON.stringify({ ...connectAuthUsersByKey(one.document, ast), file: one.file }))
}

/**
 * The engine takes one `--run-once` for the run, so a file asking for it decides for all of them.
 * Said out loud rather than generalised silently, because the difference is whether work someone
 * expected to happen happens.
 */
export function runOnceForAll(prepared: readonly Prepared[]): boolean {
  const askedRunOnce = prepared.filter((one) => one.config.runOnce === true)
  if (askedRunOnce.length > 0 && askedRunOnce.length !== prepared.length) {
    warn(
      "Some seed files declare `runOnce` and others do not, and the run takes one setting.\n" +
        `  Applying it to all of them, because ${askedRunOnce
          .map((one) => one.file)
          .join(", ")} asked for it.`,
    )
  }
  return askedRunOnce.length > 0
}
