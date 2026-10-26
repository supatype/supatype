/**
 * Locates the tsx binary shipped with this package and provides a helper
 * to run TypeScript files at runtime.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { uniqueFileToken } from "./unique-file-token.js"
import { isCompiledBinary } from "./cli-install-method.js"

const _require = createRequire(import.meta.url)

/** The directory this module was loaded from: the CLI's `src` in development, `dist` installed. */
const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * A `file:` URL for one of the CLI's own modules, for a snippet to import.
 *
 * Snippets run from the user's temp directory, so a relative `./seed.js` would resolve there and
 * find nothing. An absolute URL reaches the module wherever the CLI is installed, and the module's
 * own imports resolve from its own location as they always did.
 */
export function cliModuleUrl(name: string): string {
  return pathToFileURL(resolve(CLI_SRC_DIR, name)).href
}

/**
 * Resolve the absolute path to the tsx CLI entry point.
 * tsx is a direct dependency so this will always succeed after `npm install`.
 */
function findTsxBin(): string {
  try {
    const pkgPath = _require.resolve("tsx/package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      bin?: string | Record<string, string>
    }
    const binRelative =
      typeof pkg.bin === "string"
        ? pkg.bin
        : (pkg.bin?.["tsx"] ?? "./dist/cli.mjs")
    return resolve(dirname(pkgPath), binRelative)
  } catch {
    return "tsx" // last-resort: hope it's on PATH
  }
}

const TSX_BIN = findTsxBin()


export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Run a TypeScript file with tsx and capture output. */
export function runTsFile(
  filePath: string,
  opts: SpawnSyncOptions = {},
): RunResult {
  // Same split as importModuleAsJson: the binary interprets TypeScript itself, Node uses tsx.
  const argv = isCompiledBinary() ? ["_run-ts", filePath] : [TSX_BIN, filePath]
  const result = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  })
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exitCode: result.status ?? 1,
  }
}

/**
 * The snippet file's name, unique to this call: every CLI process writes into the same directory,
 * and a name another process can also produce is a snippet another process can run.
 */
export function evalTempFileName(): string {
  return `supatype-eval-${uniqueFileToken()}.mts`
}

/**
 * Evaluate an ESM TypeScript snippet via tsx and return its stdout.
 * The snippet should write JSON to process.stdout.
 */
export function evalTsSnippet(
  snippet: string,
  opts: SpawnSyncOptions = {},
): RunResult {
  // In a directory of this call's own under the user's temp directory. It used to be written beside
  // the CLI's source, which a global install owned by root does not let the user write to, so every
  // `diff` failed with EACCES (A5-N4). The CLI's own modules are imported through `cliModuleUrl`.
  // The subprocess CWD is kept as opts.cwd (the user's project dir) so that any relative paths in
  // the snippet resolve correctly.
  const dir = mkdtempSync(join(tmpdir(), "supatype-eval-"))
  const tmpFile = join(dir, evalTempFileName())
  try {
    // This user's only, and never written through a name that already exists: a snippet can carry
    // a project's config or connection string. `mkdtemp` makes the directory 0700 as well.
    writeFileSync(tmpFile, snippet, { encoding: "utf8", mode: 0o600, flag: "wx" })
    return runTsFile(tmpFile, opts)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Import a module and return its default export as JSON text.
 *
 * Two interpreters, one contract. Under Node this writes a snippet and runs it through tsx, as
 * it always has. As a compiled binary it re-executes itself, because there is no node_modules to
 * resolve tsx from, no writable directory beside the executable, and on a `curl | sh` machine no
 * Node either: the previous behaviour failed with
 * `ENOENT: open '/$bunfs/root/supatype-eval-....mts'` and broke init, update, dev and push.
 *
 * Callers get the same stdout, stderr and exit code either way.
 */
export function importModuleAsJson(
  target: string,
  opts: SpawnSyncOptions = {},
): RunResult {
  if (isCompiledBinary()) {
    const result = spawnSync(process.execPath, ["_print-module", target], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      ...opts,
    })
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      exitCode: result.status ?? 1,
    }
  }

  const snippet = `
const mod = await import(${JSON.stringify(target)})
const config = mod.default ?? mod
process.stdout.write(JSON.stringify(config))
`
  return evalTsSnippet(snippet, opts)
}
