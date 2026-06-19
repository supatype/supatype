#!/usr/bin/env node
/**
 * Embed minisign public key into @supatype/cli before npm publish.
 * Usage: node scripts/embed-release-pubkey.mjs "<minisign-public-key-text>"
 * Or set MINISIGN_PUBLIC_KEY in the environment (CI).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const key = (process.argv[2] ?? process.env["MINISIGN_PUBLIC_KEY"] ?? "").trim()
if (!key) {
  // Fail closed: publishing without the embedded public key would ship a CLI that
  // cannot verify release authenticity. Never publish in that state silently.
  console.error(
    "embed-release-pubkey: no key provided. Set the MINISIGN_PUBLIC_KEY secret " +
      "(or pass the key as an argument) before building for publish.",
  )
  process.exit(1)
}

const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/cli/src/release-public-key.ts",
)
const marker = 'export const EMBEDDED_RELEASE_PUBLIC_KEY = ""'
const replacement = `export const EMBEDDED_RELEASE_PUBLIC_KEY = ${JSON.stringify(key)}`

let text = readFileSync(target, "utf8")
if (!text.includes(marker)) {
  console.error("embed-release-pubkey: marker not found in release-public-key.ts")
  process.exit(1)
}
text = text.replace(marker, replacement)
writeFileSync(target, text, "utf8")
console.log("embed-release-pubkey: embedded public key into packages/cli/src/release-public-key.ts")
