#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "release-bundle")
mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, "supatype-cli-bundle.cjs")

const result = spawnSync(
  "npx",
  [
    "--yes", "esbuild@0.25.5",
    join(root, "dist", "cli.js"),
    "--bundle",
    "--platform=node",
    "--target=node22",
    "--format=cjs",
    `--outfile=${outfile}`,
    `--banner:js=#!/usr/bin/env node`,
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
)
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Wrote ${outfile}`)
