/**
 * The files a deploy sends for a function or a hook kept as a directory: exactly those the worker
 * loads, the rule a self-hosted control plane also hashes by, so what is sent is what is served.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { toPosixPath, workerLoadsFile } from "@supatype/shared"

/** Every file under `dir` the worker loads ({@link workerLoadsFile}), by its `/` path under `dir` on every OS. */
export function readWorkerFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const fullPath = join(dir, entry)
    if (workerLoadsFile(entry) && statSync(fullPath).isFile()) files[toPosixPath(entry)] = readFileSync(fullPath, "utf8")
  }
  return files
}
