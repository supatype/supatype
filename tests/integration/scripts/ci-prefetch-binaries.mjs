#!/usr/bin/env node
/**
 * Download engine/server/postgres/deno binaries for tests/integration/supatype.config.ts.
 * Run after `pnpm build` (needs packages/cli/dist).
 */
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { downloadAll } from "../../../packages/cli/dist/binary-cache.js"
import { loadConfig } from "../../../packages/cli/dist/config.js"

const integrationDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const config = loadConfig(integrationDir)

console.log("[ci] Prefetching component binaries...")
await downloadAll(config.versions, false)
console.log("[ci] Done.")
