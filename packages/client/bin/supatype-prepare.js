#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { lstatSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

// A Supatype project's `prepare`: `supatype generate` where the CLI is installed, and nothing where
// it is not.
//
// The generated files are gitignored, so a fresh clone has to produce them before anything can
// import them. A production install leaves out development dependencies, the CLI among them, but
// npm still runs `prepare`, and a bare `supatype generate` failed it with `supatype: not found`.
// Nothing needs generating there: the build that imports the files ran with everything installed.
// Prisma's client skips its generate the same way when the Prisma CLI is not installed.
//
// It ships here, in a package a project installs for production too, rather than as a script
// written into each project's package.json, so a fix to it reaches every project with an upgrade.
// Yarn 2 and later do not run a project's own `prepare` on install, so there `supatype generate`
// is run by hand.

/**
 * The node_modules folders Node looks in for a package from `dir`, nearest first: beside it and in
 * each folder above it, where a workspace hoists the CLI. Not NODE_PATH or the global folders,
 * which belong to no project.
 */
function nodeModulesFolders(dir) {
  const folders = []
  for (let p = dir; ; p = dirname(p)) {
    if (basename(p) !== "node_modules") folders.push(join(p, "node_modules"))
    if (dirname(p) === p) return folders
  }
}

/** A folder that cannot be looked at is passed over, as Node passes it over. */
function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** The `supatype` bin the CLI's own package.json names. Throws when the CLI cannot be read. */
function cliBin(cli) {
  const { bin } = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"))
  const entry = typeof bin === "string" ? bin : bin?.supatype
  if (typeof entry !== "string") throw new Error("its package.json names no supatype bin")
  return join(cli, entry)
}

const cli = nodeModulesFolders(process.cwd())
  .map((folder) => join(folder, "@supatype", "cli"))
  .find(exists)
if (cli === undefined) process.exit(0)

// A CLI folder that is there but broken, such as a link into a pruned pnpm store, fails the
// install: skipping it would pass the install and fail the build later, on files never generated.
let bin
try {
  bin = cliBin(cli)
} catch (e) {
  console.error(`supatype-prepare: cannot read the Supatype CLI at ${cli}: ${e.message}`)
  process.exit(1)
}
const result = spawnSync(process.execPath, [bin, "generate"], { stdio: "inherit" })
if (result.error) console.error(`supatype-prepare: ${result.error.message}`)
if (result.signal) console.error(`supatype-prepare: supatype generate was stopped by ${result.signal}`)
process.exit(result.status ?? 1)
