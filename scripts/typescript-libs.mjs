#!/usr/bin/env node
/**
 * The schema extractor asks TypeScript's checker what a `JSON<T>` column's `T` is, and the checker
 * needs TypeScript's lib files to know `Array`, `Record` and the rest. The CLI ships as a single
 * compiled executable, which carries the compiler's JavaScript but not those .d.ts files, so they go
 * into the CLI as a generated module: packages/cli/src/generated/typescript-libs.ts.
 *
 * The root lib and every lib it references go in, read from the TypeScript the CLI depends on, so
 * the compiler that runs and the libs it reads are one version. Line endings are written as LF
 * whatever the checkout has, so a Windows working tree and a Linux runner generate the same file.
 *
 * Usage:
 *   node scripts/typescript-libs.mjs generate [--check]
 *
 * `generate --check` writes nothing and exits 1 when the CLI's copy is stale.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI_DIR = join(ROOT, "packages", "cli")
const GENERATED = join(CLI_DIR, "src", "generated", "typescript-libs.ts")

/** The lib the extractor's checker loads. ES only: a schema has no use for the DOM. */
const ROOT_LIB = "lib.es2022.d.ts"

function die(message) {
  console.error(`typescript-libs: ${message}`)
  process.exit(1)
}

/** The text of a file with LF line endings. */
function lf(text) {
  return text.replace(/\r\n/g, "\n")
}

/** TypeScript as the CLI resolves it: its lib directory and its version. */
function typescript() {
  const require = createRequire(join(CLI_DIR, "package.json"))
  const pkg = require.resolve("typescript/package.json")
  return { libDir: join(dirname(pkg), "lib"), version: JSON.parse(readFileSync(pkg, "utf8")).version }
}

/** `ROOT_LIB` and every lib it references, transitively, by file name, sorted. */
function libFiles(libDir) {
  const files = new Map()
  const visit = (name) => {
    if (files.has(name)) return
    const text = lf(readFileSync(join(libDir, name), "utf8"))
    files.set(name, text)
    for (const ref of text.matchAll(/<reference lib="([^"]+)"/g)) visit(`lib.${ref[1].toLowerCase()}.d.ts`)
  }
  visit(ROOT_LIB)
  return [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

function render(version, files) {
  return [
    "// Generated from TypeScript's lib directory by scripts/typescript-libs.mjs. Do not edit: the",
    "// CLI's build regenerates it, and the schema extractor's type checker reads these files.",
    `export const TYPESCRIPT_LIB_VERSION = ${JSON.stringify(version)}`,
    `export const TYPESCRIPT_ROOT_LIB = ${JSON.stringify(ROOT_LIB)}`,
    "export const TYPESCRIPT_LIB_FILES: Readonly<Record<string, string>> = {",
    ...files.map(([name, text]) => `  ${JSON.stringify(name)}: ${JSON.stringify(text)},`),
    "}",
    "",
  ].join("\n")
}

function readText(path) {
  try {
    return lf(readFileSync(path, "utf8"))
  } catch {
    return ""
  }
}

function generate(check) {
  const { libDir, version } = typescript()
  const text = render(version, libFiles(libDir))
  if (readText(GENERATED) === text) return
  if (check) die(`${GENERATED} is stale: run 'node scripts/typescript-libs.mjs generate'`)
  mkdirSync(dirname(GENERATED), { recursive: true })
  writeFileSync(GENERATED, text, "utf8")
}

const [command, ...args] = process.argv.slice(2)
if (command === "generate") generate(args[0] === "--check")
else die("usage: typescript-libs.mjs generate [--check]")
