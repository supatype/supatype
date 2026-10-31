import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provisionSchemaBuckets, reportLocalPush } from "../src/commands/push.js"

/**
 * Local test round 4: `supatype push` exited 0 when every bucket the schema declares failed to
 * provision. A push ends non-zero when anything it was asked to do after the schema did not happen
 * (the hooks, the database checks), so a bucket the stack does not have does too, named.
 */
const said: string[] = []

beforeEach(() => {
  said.length = 0
  process.exitCode = undefined
  for (const stream of ["log", "warn", "error"] as const) {
    vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
  }
})

afterEach(() => {
  process.exitCode = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const buckets = { storageBuckets: [{ id: "pics" }, { id: "docs" }] }

describe("a push whose buckets the storage service refuses", () => {
  it("ends non-zero, naming the buckets that are not there", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) =>
      String(init?.body).includes('"pics"')
        ? Response.json({ error: "file_size_limit must be a whole number" }, { status: 400 })
        : Response.json({ name: "docs" }),
    )
    await provisionSchemaBuckets(buckets, "http://127.0.0.1:1/storage/v1", "key")
    expect(process.exitCode).toBe(1)
    expect(said.join("\n")).toContain("The schema was applied, but 1 of 2 bucket(s) were not provisioned: pics")
  })

  it("ends as it was when every bucket is there", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ name: "x" }))
    await provisionSchemaBuckets(buckets, "http://127.0.0.1:1/storage/v1", "key")
    expect(process.exitCode).toBeUndefined()
  })
})

// Review B4: the local push ignored the bucket failure and ended with the Studio link, which read as
// success below it; it ends as a linked target's push does.
describe("how a push to the project's own stack ends", () => {
  const local = { mode: "local", environment: "dev" } as const

  it("says it did not finish, with no Studio link, when its buckets failed", () => {
    reportLocalPush(local, "http://127.0.0.1:54321/studio", true)
    const out = said.join("\n")
    expect(out).toContain("The push to local (dev) did not finish: the schema is applied, but a step after it failed (above).")
    expect(out).not.toContain("Studio:")
  })

  it("gives the Studio link when every step finished", () => {
    reportLocalPush(local, "http://127.0.0.1:54321/studio", false)
    expect(said.join("\n")).toContain("Studio: http://127.0.0.1:54321/studio")
  })
})
