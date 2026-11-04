// Copies the package stylesheet into dist/ so the "./styles.css" export resolves.
// tsc only emits .js and .d.ts, so the build runs this after it.
import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const from = join(pkgDir, "src", "styles.css")
const to = join(pkgDir, "dist", "styles.css")

mkdirSync(dirname(to), { recursive: true })
copyFileSync(from, to)
