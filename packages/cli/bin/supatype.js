#!/usr/bin/env node
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const cli = new URL("../dist/cli.js", import.meta.url)

// A fresh clone of the monorepo has no dist until its first build. Only that case gets the hint:
// a module missing from inside a built dist is reported as it is.
function unbuilt(e) {
  return e?.code === "ERR_MODULE_NOT_FOUND" && !existsSync(fileURLToPath(cli))
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
    console.error(e?.message ?? e)
    process.exit(1)
  })
