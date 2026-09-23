/**
 * Locates the tsx binary shipped with this package and provides a helper
 * to run TypeScript files at runtime.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { isCompiledBinary } from "./cli-install-method.js"

const _require = createRequire(import.meta.url)

// The CLI's own source directory, workspace packages are
// resolvable from here. Eval snippets are written here so ESM resolution finds them.
const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url))

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
 * Evaluate an ESM TypeScript snippet via tsx and return its stdout.
 * The snippet should write JSON to process.stdout.
 */
export function evalTsSnippet(
  snippet: string,
  opts: SpawnSyncOptions = {},
): RunResult {
  // Always write the temp file into the CLI's source directory so that ESM
  // resolution can find workspace packages from there.
  // The subprocess CWD is kept as opts.cwd (the user's project dir) so that
  // any relative paths in the snippet resolve correctly.
  const tmpFile = resolve(CLI_SRC_DIR, `supatype-eval-${Date.now()}.mts`)
  writeFileSync(tmpFile, snippet, "utf8")
  try {
    return runTsFile(tmpFile, opts)
  } finally {
    try {
      unlinkSync(tmpFile)
    } catch {
      // ignore cleanup errors
    }
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
