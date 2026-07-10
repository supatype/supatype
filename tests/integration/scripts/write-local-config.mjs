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
import { dirname, resolve } from "node:path"

const out = process.argv[2]
if (!out) {
  console.error("usage: write-local-config.mjs <path-to-supatype.local.config.ts>")
  process.exit(1)
}

const o = {}

function resolveExecutablePath(val) {
  if (!val) return null
  if (existsSync(val) && statSync(val).isFile()) return val
  if (process.platform === "win32" && !val.toLowerCase().endsWith(".exe")) {
    const exe = `${val}.exe`
    if (existsSync(exe) && statSync(exe).isFile()) return exe
  }
  return null
}

function addBin(key, val) {
  const resolved = resolveExecutablePath(val)
  if (!resolved) return
  try {
    const st = statSync(resolved)
    if (!st.isFile()) return
    // Windows .exe files often fail constants.X_OK — existence + isFile is enough.
    if (process.platform !== "win32") {
      accessSync(val, constants.X_OK)
    }
    o[key] = resolve(resolved).replace(/\\/g, "/")
  } catch {
    /* inaccessible */
  }
}

addBin("engine", process.env["SUPATYPE_ENGINE"])
addBin("server", process.env["SUPATYPE_SERVER"])
addBin("realtime", process.env["SUPATYPE_REALTIME"])

const integrationDir = dirname(resolve(out))
const defaultRealtime = resolve(integrationDir, "../../packages/realtime/dist/index.js")
if (!o["realtime"] && existsSync(defaultRealtime)) {
  o["realtime"] = defaultRealtime.replace(/\\/g, "/")
}

const pg = process.env["SUPATYPE_POSTGRES_DIR"]
if (pg && existsSync(pg) && statSync(pg).isDirectory()) {
  o["postgres_dir"] = resolve(pg).replace(/\\/g, "/")
}

const studio = process.env["SUPATYPE_STUDIO_DIR"]
if (studio && existsSync(studio) && statSync(studio).isDirectory()) {
  o["studio"] = resolve(studio).replace(/\\/g, "/")
} else {
  const integrationDir = dirname(resolve(out))
  const defaultStudio = resolve(integrationDir, "../../packages/studio")
  if (existsSync(defaultStudio) && statSync(defaultStudio).isDirectory()) {
    o["studio"] = "../../packages/studio"
  }
}

const prov =
  process.env["SUPATYPE_PROVIDER"] ?? process.env["SUPATYPE_DATABASE_PROVIDER"]
const partial = {}
if (Object.keys(o).length > 0) {
  partial.overrides = o
  const versions = {}
  if (o.engine) versions.engine = "local"
  if (o.server) versions.server = "local"
  if (o.realtime) versions.realtime = "local"
  if (Object.keys(versions).length > 0) {
    partial.versions = versions
  }
}
if (prov === "native" || prov === "docker") {
  partial.provider = prov
  partial.database = { provider: prov }
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
