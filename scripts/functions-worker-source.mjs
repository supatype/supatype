#!/usr/bin/env node
/**
 * Native `supatype dev` and `supatype functions serve` run the functions worker itself
 * (packages/functions-worker), not a copy of its rules, so a function behaves locally as it does
 * in the image. The CLI ships as an npm package and as a single compiled executable, and neither
 * can read files from this repository at run time, so the worker's source goes into the CLI as a
 * generated module: packages/cli/src/generated/functions-worker-source.ts.
 *
 * Every top-level .ts file goes in, as the image's `COPY deno.json *.ts ./` takes them, so a module
 * split out of main.ts later cannot be left behind. Line endings are written as LF whatever the
 * checkout has, so a Windows working tree and a Linux runner generate the same file.
 *
 * It first writes the worker's dotenv parser, packages/functions-worker/dotenv.ts, from the CLI's
 * (packages/cli/src/dotenv-parse.ts), so the two read a `.env` file with one set of rules.
 *
 * Usage:
 *   node scripts/functions-worker-source.mjs generate [--check]
 *
 * `generate --check` writes nothing and exits 1 when the CLI's copy is stale.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const WORKER_DIR = join(ROOT, "packages", "functions-worker")
const GENERATED = join(ROOT, "packages", "cli", "src", "generated", "functions-worker-source.ts")
const DOTENV_SOURCE = join(ROOT, "packages", "cli", "src", "dotenv-parse.ts")
const WORKER_DOTENV = join(WORKER_DIR, "dotenv.ts")

function die(message) {
  console.error(`functions-worker-source: ${message}`)
  process.exit(1)
}

/** The text of a file with LF line endings. */
function lf(text) {
  return text.replace(/\r\n/g, "\n")
}

/** The worker's top-level .ts files by name, sorted so the output does not depend on the filesystem. */
function workerFiles() {
  const names = readdirSync(WORKER_DIR).filter((name) => name.endsWith(".ts")).sort()
  if (!names.includes("main.ts")) die(`${WORKER_DIR} has no main.ts`)
  return names.map((name) => [name, lf(readFileSync(join(WORKER_DIR, name), "utf8"))])
}

function render(files) {
  return [
    "// Generated from packages/functions-worker/*.ts by scripts/functions-worker-source.mjs. Do not",
    "// edit: the CLI's build regenerates it, and native dev and `functions serve` run these files.",
    "export const FUNCTIONS_WORKER_SOURCE: Readonly<Record<string, string>> = {",
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

/** The worker's dotenv.ts: the CLI's parser under a header saying where it comes from. */
function workerDotenv() {
  return [
    "// Generated from packages/cli/src/dotenv-parse.ts by scripts/functions-worker-source.mjs. Do not",
    "// edit: change that file and run the script, so the CLI and the worker read .env files alike.",
    lf(readFileSync(DOTENV_SOURCE, "utf8")),
  ].join("\n")
}

/** Writes `text` to `path` when it differs; with `check`, exits 1 instead of writing. */
function writeGenerated(path, text, check) {
  if (readText(path) === text) return
  if (check) die(`${path} is stale: run 'node scripts/functions-worker-source.mjs generate'`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, "utf8")
}

function generate(check) {
  writeGenerated(WORKER_DOTENV, workerDotenv(), check)
  writeGenerated(GENERATED, render(workerFiles()), check)
}

const [command, ...args] = process.argv.slice(2)
if (command === "generate") generate(args[0] === "--check")
else die("usage: functions-worker-source.mjs generate [--check]")
