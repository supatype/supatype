import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { renderSelfHostCompose, writeSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * SC3: the functions worker runs user code, and it shared one network with every service, so a
 * function could open the database, the keyspace, storage, its object store or the control plane
 * directly. The worker now has a network of its own with the gateway only (Kong, and the server
 * that calls the worker), plus the database alone when the project opted into a direct database
 * URL for functions (`SUPATYPE_FUNCTIONS_DB_URL` naming `db`).
 */

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
}

/** One service's block, ending at the next service or at a top-level key. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n")
  const start = lines.indexOf(`  ${name}:`)
  if (start === -1) return ""
  const after = lines.slice(start + 1).findIndex((l) => /^ {2}[a-z][a-z0-9-]*:$/.test(l) || /^[a-z]/.test(l))
  return lines.slice(start, after === -1 ? lines.length : start + 1 + after).join("\n")
}

/** The networks a service block lists; `["default"]` when it lists none, as compose reads it. */
function networksOf(block: string): string[] {
  const lines = block.split("\n")
  const at = lines.indexOf("    networks:")
  if (at === -1) return ["default"]
  const listed: string[] = []
  for (const line of lines.slice(at + 1)) {
    const match = /^ {6}- ([\w-]+)$/.exec(line)
    if (match?.[1] === undefined) break
    listed.push(match[1])
  }
  return listed
}

/** The top-level `networks:` section's names. */
function declaredNetworks(compose: string): string[] {
  const lines = compose.split("\n")
  const at = lines.indexOf("networks:")
  if (at === -1) return []
  const names: string[] = []
  for (const line of lines.slice(at + 1)) {
    const match = /^ {2}([\w-]+):/.exec(line)
    if (match?.[1] !== undefined) names.push(match[1])
    else if (/^\S/.test(line)) break
  }
  return names
}

const OTHERS = ["db", "postgrest", "storage", "realtime", "control-plane", "seaweedfs", "schema-engine", "studio", "valkey"]

describe("the functions worker's network", () => {
  for (const devLocal of [true, false]) {
    describe(devLocal ? "dev" : "self-host", () => {
      const compose = renderSelfHostCompose(config, process.cwd(), { devLocal })

      it("holds the worker and the gateway only", () => {
        expect(networksOf(serviceBlock(compose, "functions-worker"))).toEqual(["functions"])
        expect(networksOf(serviceBlock(compose, "kong"))).toEqual(["default", "functions"])
        expect(networksOf(serviceBlock(compose, "server"))).toEqual(["default", "functions"])
        expect(declaredNetworks(compose)).toContain("functions")
      })

      it("leaves the database, keyspace, storage and control plane off it", () => {
        for (const service of OTHERS) {
          const block = serviceBlock(compose, service)
          if (block === "") continue
          expect(networksOf(block), service).toEqual(["default"])
        }
      })

      it("still points the worker at the gateway by a name it can resolve", () => {
        expect(serviceBlock(compose, "functions-worker")).toContain("SUPATYPE_URL: http://kong:8000")
      })
    })
  }

  it("adds the database alone when functions were given a direct database URL", () => {
    const compose = renderSelfHostCompose(config, process.cwd(), { functionsDatabase: true })
    expect(networksOf(serviceBlock(compose, "functions-worker"))).toEqual(["functions", "functions-db"])
    expect(networksOf(serviceBlock(compose, "db"))).toEqual(["default", "functions-db"])
    expect(declaredNetworks(compose)).toEqual(expect.arrayContaining(["functions", "functions-db"]))
    for (const service of OTHERS.filter((s) => s !== "db")) {
      const block = serviceBlock(compose, service)
      if (block !== "") expect(networksOf(block), service).not.toContain("functions-db")
    }
  })
})

describe("writeSelfHostCompose() and SUPATYPE_FUNCTIONS_DB_URL", () => {
  let dir = ""

  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true })
    dir = ""
  })

  /** The worker's networks for a project whose .env sets `dbUrl` (or nothing). */
  function workerNetworks(dbUrl?: string): string[] {
    dir = mkdtempSync(join(tmpdir(), "supatype-sc3-"))
    writeFileSync(join(dir, ".env"), dbUrl === undefined ? "" : `SUPATYPE_FUNCTIONS_DB_URL=${dbUrl}\n`)
    const paths = writeSelfHostCompose(dir, config, { devLocal: true, fieldMaskingTier: "extension", drafts: false })
    return networksOf(serviceBlock(readFileSync(paths.composePath, "utf8"), "functions-worker"))
  }

  it("reaches the database only when the URL the functions were given names it", () => {
    expect(workerNetworks()).toEqual(["functions"])
    expect(workerNetworks("postgres://fn:pw@db:5432/supatype")).toEqual(["functions", "functions-db"])
    expect(workerNetworks("postgres://fn:pw@db.example.com:5432/app")).toEqual(["functions"])
  })
})
