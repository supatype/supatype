#!/usr/bin/env node
/**
 * Writes tests/integration/supatype.local.config.ts from SUPATYPE_* env vars.
 * Removes the file when there is nothing to override.
 */
import {
  accessSync,
  constants,
  existsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

const out = process.argv[2]
if (!out) {
  console.error("usage: write-local-config.mjs <path-to-supatype.local.config.ts>")
  process.exit(1)
}

const o = {}

function addBin(key, val) {
  if (!val || !existsSync(val)) return
  try {
    accessSync(val, constants.X_OK)
    o[key] = resolve(val)
  } catch {
    /* not executable or inaccessible */
  }
}

addBin("engine", process.env["SUPATYPE_ENGINE"])
addBin("server", process.env["SUPATYPE_SERVER"])

const pg = process.env["SUPATYPE_POSTGRES_DIR"]
if (pg && existsSync(pg) && statSync(pg).isDirectory()) {
  o["postgres_dir"] = resolve(pg)
}

const dbp = process.env["SUPATYPE_DATABASE_PROVIDER"]
const database =
  dbp === "native" || dbp === "docker" ? { provider: dbp } : undefined

const partial = {}
if (Object.keys(o).length > 0) {
  partial.overrides = o
}
if (database !== undefined) {
  partial.database = database
}

if (Object.keys(partial).length === 0) {
  try {
    unlinkSync(out)
  } catch {
    /* absent */
  }
  process.exit(0)
}

const body =
  `import type { SupatypeProjectConfig } from "@supatype/cli"\n` +
  `export default ${JSON.stringify(partial, null, 2)} as Partial<SupatypeProjectConfig>\n`

writeFileSync(out, body, "utf8")
