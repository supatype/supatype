import { createServer, type Server } from "node:http"
import { portOf } from "./helpers/listen.js"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cacheSeedingNotes } from "../src/api-config-cache.js"
import { isJsonObject } from "@supatype/shared"

/**
 * A model's cache block is a ceiling; the runtime allowlist is what is on. These run `push`'s and
 * `dev`'s seeding against a fake admin API, because the real writer is the running stack.
 */
const ast = { models: [{ name: "Post", annotations: { db: { tableName: "posts" }, platform: { cache: { enabled: true } } } }] }

interface Fake { server: Server; url: string; patches: unknown[] }
/** The JSON object a PATCH carried; anything else merges nothing. */
function patchBody(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body)
  return isJsonObject(parsed) ? parsed : {}
}

const servers: Server[] = []
const dirs: string[] = []

async function fakeAdmin(rest: Record<string, unknown>, patchStatus = 200): Promise<Fake> {
  const patches: unknown[] = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c: Buffer) => (body += c.toString()))
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.method === "PATCH") {
        patches.push(JSON.parse(body))
        const merged = { ...rest, ...patchBody(body) }
        res.writeHead(patchStatus).end(JSON.stringify(patchStatus === 200 ? merged : { error: "rest_cache_not_available" }))
        return
      }
      res.writeHead(200).end(JSON.stringify(rest))
    })
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  servers.push(server)
  return { server, url: `http://127.0.0.1:${portOf(server)}`, patches }
}

function project(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-stackseed-"))
  dirs.push(dir)
  writeFileSync(join(dir, ".env"), `SUPATYPE_URL=${url}\nSERVICE_ROLE_KEY=svc\n`, "utf8")
  return dir
}

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((ok) => { s.closeAllConnections(); s.close(() => ok()) })
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("seeding through the running stack", () => {
  it("PATCHes the declared table, keeping entries that already exist, and says the TTL is 0", async () => {
    const fake = await fakeAdmin({ cache_max_ttl: 0, cache_tables: { legacy: { enabled: false, allow_public: false } } })
    const notes = await cacheSeedingNotes(project(fake.url), ast)

    expect(fake.patches).toEqual([{
      cache_tables: {
        legacy: { enabled: false, allow_public: false },
        posts: { enabled: true, allow_public: false },
      },
    }])
    expect(notes.join("\n")).toContain("Server cache enabled for posts")
    expect(notes.join("\n")).toContain("cache_max_ttl is 0")
  })

  it("does not PATCH, and stays quiet about the TTL, when the table is on and a TTL is set", async () => {
    const fake = await fakeAdmin({ cache_max_ttl: 60, cache_tables: { posts: { enabled: true, allow_public: false } } })
    expect(await cacheSeedingNotes(project(fake.url), ast)).toEqual([])
    expect(fake.patches).toEqual([])
  })

  it("prints the TTL note even when the table was already on", async () => {
    const fake = await fakeAdmin({ cache_max_ttl: 0, cache_tables: { posts: { enabled: true, allow_public: false } } })
    const notes = await cacheSeedingNotes(project(fake.url), ast)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("cache_max_ttl is 0")
  })

  it("says nothing where the server refuses the cache (a free plan)", async () => {
    const fake = await fakeAdmin({ cache_max_ttl: 0, cache_tables: {} }, 403)
    expect(await cacheSeedingNotes(project(fake.url), ast)).toEqual([])
  })

  it("creates the file from the default shape when the stack is not answering", async () => {
    const dir = project("http://127.0.0.1:1")
    const notes = await cacheSeedingNotes(dir, ast)
    const file = join(dir, ".supatype", "api-config.json")
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf8")).toContain('"posts"')
    expect(notes.join("\n")).toContain("cache_max_ttl is 0")
  })
})
