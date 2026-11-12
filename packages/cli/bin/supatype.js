#!/usr/bin/env node
// First, so a Node older than the package supports is told so before anything else loads or fails.
// This file is kept to syntax that Node parses as far back as it loads ES modules, and to built-in
// names without the `node:` prefix (which Node 12 and early 14 refuse), so the check gets to run.
import "./node-version.js"
import { existsSync } from "fs"
import { fileURLToPath } from "url"

// Installed from npm, this file sits under a `node_modules` directory and starts the compiled
// program for this machine (dist/cli-launcher.js says why). In the monorepo it runs the CLI's
// JavaScript, which is what the CLI's own tests and a workspace link exercise. Node reports this
// file's real path, so a workspace package linked into an app's node_modules still counts as the
// monorepo. A copy kept outside node_modules (Deno's npm cache, a vendored copy) counts as installed
// too: the JavaScript's own dependencies are development-only, so it could not run there.
function hasJavaScriptDependencies() {
  try {
    import.meta.resolve("commander")
    return true
  } catch {
    return false
  }
}
const installed = fileURLToPath(import.meta.url).split(/[\\/]/).includes("node_modules") || !hasJavaScriptDependencies()
const cli = new URL(installed ? "../dist/cli-launcher.js" : "../dist/cli.js", import.meta.url)

// A fresh clone of the monorepo has no dist until its first build. Only that case gets the hint:
// a module missing from inside a built dist is reported as it is.
function unbuilt(e) {
  return e != null && e.code === "ERR_MODULE_NOT_FOUND" && !existsSync(fileURLToPath(cli))
}

import(cli.href)
  .catch((e) => {
    if (!unbuilt(e)) throw e
    console.error(
      "The Supatype CLI has not been built: dist/cli.js is missing.\n" +
        "Run `pnpm install && pnpm build` at the repository root, then try again.",
    )
    process.exit(1)
  })
  .then((m) => m.run())
  .catch((e) => {
    console.error(e != null && e.message !== undefined ? e.message : e)
    process.exit(1)
  })
