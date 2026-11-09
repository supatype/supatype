/**
 * The half of seed collection that runs in the child process.
 *
 * A real module rather than text pasted into a snippet, so both interpreters run the same code.
 * Under Node a snippet imports this file by its path. The standalone binary cannot do that: its
 * modules live in an embedded filesystem (`B:\~BUN\root` on Windows, `/$bunfs/root` elsewhere)
 * that a module evaluated from the temp directory cannot import from, which failed every seed
 * (issue 61). The binary runs `_collect-seed` on itself instead, which calls this directly.
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isJsonObject, isShape, isString, optional, type Guard } from "@supatype/shared"
import { SeedCollector, type Manifest } from "./seed-ir.js"
import { expr, type SeedContext } from "./seed.js"

/** One seed file to collect, and where to write what it described. */
export interface SeedJob {
  file: string
  outPath: string
  /** The generated builder, for the manifest and the schema fingerprint. */
  builderPath: string
  environment?: string
}

/** The generated builder writes `seedModels` as the manifest, so an object is taken as one. */
function isManifest(value: unknown): value is Manifest {
  return isJsonObject(value)
}

const isBuilder = isShape({ schemaFingerprint: isString, seedModels: isManifest })

type SeedFunction = (context: SeedContext) => unknown

function isSeedFunction(value: unknown): value is SeedFunction {
  return typeof value === "function"
}

/** A `SeedJob` as `_collect-seed` receives it, on its command line. */
export const isSeedJob: Guard<SeedJob> = isShape({
  file: isString,
  outPath: isString,
  builderPath: isString,
  environment: optional(isString),
})

/** Import a file by its path, as a `file:` URL so a Windows drive letter is not read as a scheme. */
export async function importFile(path: string): Promise<unknown> {
  return import(pathToFileURL(resolve(path)).href)
}

/** Import the seed file, run its default export against a collector, and write the result. */
export async function collectSeedHere(job: SeedJob): Promise<void> {
  const builder = await importFile(job.builderPath)
  const imported = await importFile(job.file)
  const seed = isJsonObject(imported) ? imported : {}
  const run = seed["default"]
  if (!isSeedFunction(run)) {
    // Importing it is what ran it, which is the old contract working exactly as it did.
    writeFileSync(job.outPath, JSON.stringify({ shape: "legacy" }))
    return
  }
  if (!isBuilder(builder)) {
    throw new Error(`${job.builderPath} does not export schemaFingerprint and seedModels. Run: supatype generate`)
  }
  const collector = new SeedCollector(builder.schemaFingerprint, builder.seedModels)
  await run({
    db: collector.db(),
    expr,
    log: (message) => {
      console.log(message)
    },
    environment: job.environment,
  })
  const config = seed["config"] ?? {}
  writeFileSync(job.outPath, JSON.stringify({ shape: "collected", ir: collector.finish().ir, config }))
}
