#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "release-bundle")
mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, "supatype-realtime-bundle.cjs")
// The process entry package.json declares (`supatype.entry`), which always starts the server.
const entry = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).supatype.entry

// On Windows `npx` is a .cmd and only runs through a shell, which would split and rewrite an
// argument holding the shebang ("#!/usr/bin/env node" has a space, and the path can be mangled).
// So no argument carries it: the shebang is written onto the bundle afterwards.
const result = spawnSync(
  "npx",
  [
    "--yes", "esbuild@0.25.5",
    join(root, entry),
    "--bundle",
    "--platform=node",
    "--target=node22",
    "--format=cjs",
    `--outfile=${outfile}`,
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
)
if (result.status !== 0) process.exit(result.status ?? 1)
writeFileSync(outfile, `#!/usr/bin/env node\n${readFileSync(outfile, "utf8")}`)
console.log(`Wrote ${outfile}`)
