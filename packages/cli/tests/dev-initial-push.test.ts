import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A failed first push in `supatype dev` must never cost the developer their database.
 *
 * The loop caught every failure, ran `docker compose down -v`, started Postgres again and pushed
 * again. An engine refusal is deterministic, so the reset was the only thing that changed between
 * attempts: the second push "succeeded" against an empty database and the developer's rows and
 * uploaded files were gone. These tests pin the three answers a failure can get: retried (Postgres
 * was not reachable yet), refused (the engine said no, and `dev` stops with what it said), and
 * exhausted.
 */

const lines: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  error: (line: string) => lines.push(`error: ${line}`),
  plain: (line?: string) => lines.push(line ?? ""),
}))

const { exitInitialPushFailed, pushInitialSchema } = await import("../src/dev-initial-push.js")

const UNMANAGED = [
  "Error: Your schema declares model(s) for table(s) Supatype does not manage: public.orders.",
  "",
  "Nothing was applied. These tables already exist without Supatype's ownership marker.",
  "What to do:",
  "  Run `supatype adopt` to bring them under management (it shows the SQL first)",
].join("\n")

const DESTRUCTIVE = "Error: 2 destructive operation(s) detected. Use --force to proceed."

const REFUSED = "error communicating with database: Connection refused (os error 111)"

function steps(failures: string[]) {
  const queue = [...failures]
  return {
    push: vi.fn(async () => {
      const next = queue.shift()
      if (next !== undefined) throw new Error(next)
    }),
    recoverDatabase: vi.fn(async () => {}),
    dumpLogs: vi.fn(),
    sleep: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  lines.length = 0
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("an engine refusal on the first attempt", () => {
  it("is returned as a refusal without a second attempt or any recovery", async () => {
    const s = steps([UNMANAGED, UNMANAGED, UNMANAGED])

    const outcome = await pushInitialSchema(s)

    expect(outcome).toEqual({ kind: "refused", reason: "unmanaged-tables", message: UNMANAGED })
    expect(s.push).toHaveBeenCalledTimes(1)
    expect(s.recoverDatabase).not.toHaveBeenCalled()
    expect(s.sleep).not.toHaveBeenCalled()
  })

  it("is recognised by the engine's JSON reason, not only by its wording", async () => {
    // The engine prints the refusal machine-readably on stdout. Matching the prose alone would
    // turn any rewording of the message back into an "engine" refusal with no adopt offer.
    const json = '{"status":"refused","reason":"unmanaged_model_tables","tables":["orders"]}'
    const s = steps([json])

    const outcome = await pushInitialSchema(s)

    expect(outcome).toMatchObject({ kind: "refused", reason: "unmanaged-tables" })
  })

  it("treats any other engine error as a refusal too", async () => {
    const s = steps([DESTRUCTIVE, DESTRUCTIVE, DESTRUCTIVE])

    const outcome = await pushInitialSchema(s)

    expect(outcome).toEqual({ kind: "refused", reason: "engine", message: DESTRUCTIVE })
    expect(s.push).toHaveBeenCalledTimes(1)
    expect(s.recoverDatabase).not.toHaveBeenCalled()
  })

  it("ends dev non-zero with the engine's message and the adopt remedy", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`)
    })

    expect(() =>
      exitInitialPushFailed({ kind: "refused", reason: "unmanaged-tables", message: UNMANAGED }),
    ).toThrow("exit 1")

    expect(exit).toHaveBeenCalledWith(1)
    const out = lines.join("\n")
    expect(out).toContain("Supatype does not manage: public.orders")
    expect(out).toContain("supatype adopt")
    expect(out).toContain("left as it was")
  })
})

describe("a database that is not reachable yet", () => {
  it("is retried, and recovered without removing anything", async () => {
    const s = steps([REFUSED])

    const outcome = await pushInitialSchema(s)

    expect(outcome).toEqual({ kind: "applied" })
    expect(s.push).toHaveBeenCalledTimes(2)
    expect(s.recoverDatabase).toHaveBeenCalledTimes(1)
  })

  it("is reported as exhausted once the attempts run out", async () => {
    const starting = "error returned from database: the database system is starting up"
    const s = steps([starting, starting, starting])

    const outcome = await pushInitialSchema(s)

    expect(outcome).toEqual({ kind: "exhausted", attempts: 3, message: starting })
    expect(s.push).toHaveBeenCalledTimes(3)
    expect(s.recoverDatabase).toHaveBeenCalledTimes(2)
  })
})

describe("the CLI source", () => {
  // The recovery a retry runs is wired up in dev-compose.ts, so the tests above cannot see what it
  // does. This one can: no code path in the CLI may tear the stack down with its volumes.
  it("never runs `docker compose down -v`", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url))
    const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((rel) => rel.endsWith(".ts"))
      .filter((rel) => /\[\s*"down"\s*,\s*"-v"/.test(readFileSync(join(src, rel), "utf8")))
    expect(offenders).toEqual([])
  })
})
