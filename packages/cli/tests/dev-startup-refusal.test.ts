import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A refused first push does not take `supatype dev` down. The engine applied nothing, so the
 * database still holds the schema it last took (and the engine recorded the refusal, which Studio
 * shows): the stack comes up on it, dev says what refused the push and the commands that resolve
 * it, and keeps watching. dev still stops when nothing could run: Postgres never answered, or
 * Docker could not pull the image the engine runs in.
 */

const lines: string[] = []
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  error: (line: string) => lines.push(`error: ${line}`),
  warn: (line: string) => lines.push(`warn: ${line}`),
  plain: (line?: string) => lines.push(line ?? ""),
  info: (line: string) => lines.push(`info: ${line}`),
}))

const { settleInitialPush } = await import("../src/dev-initial-push.js")
const { classifyRefusalOutput } = await import("../src/push-refusal.js")

const DRIFT = [
  JSON.stringify({
    status: "refused",
    reason: "security_drift",
    objects: [
      { key: { kind: "policy", schema: "public", parent: "attendee", name: "attendee_update" }, recorded: "USING (true)", live: null },
    ],
  }),
  "Error: 1 object(s) that decide who may read or write were changed outside Supatype; pass --overwrite-drift to put Supatype's definitions back.",
].join("\n")
const UNMANAGED = JSON.stringify({ status: "refused", reason: "unmanaged_model_tables", tables: ["public.orders"] })
const BUSY = JSON.stringify({ status: "refused", reason: "engine_busy" })
const DESTRUCTIVE =
  "Nothing was applied. 2 destructive operation(s) detected.\nTo drop it on purpose, run `supatype push --yes`."
const OTHER = 'Error: relation "orders" has no column "total"'
const PULL_FAILED =
  "Error response from daemon: manifest for supatype/schema-engine:9.9.9 not found: manifest unknown: manifest unknown"

/** A refused first push, as `pushInitialSchema` returns it for what the engine said. */
const refused = (message: string) => ({ kind: "refused" as const, refusal: classifyRefusalOutput(message), message })

const beforeExit = vi.fn()

beforeEach(() => {
  lines.length = 0
  beforeExit.mockReset()
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")))
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")))
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("a first push the engine refused", () => {
  it.each([
    ["security drift", DRIFT],
    ["tables Supatype does not manage", UNMANAGED],
    ["another push holding the engine", BUSY],
    ["a change that would drop data", DESTRUCTIVE],
    ["any other answer from the engine", OTHER],
  ])("leaves dev running for %s", (_name, message) => {
    expect(settleInitialPush(refused(message), { beforeExit })).toBe(false)
    expect(process.exit).not.toHaveBeenCalled()
    expect(beforeExit).not.toHaveBeenCalled()
    expect(lines.join("\n")).toMatch(/dev is running on the schema the database already has, and still watching/)
  })

  it("names every command that resolves security drift, and the objects that drifted", () => {
    settleInitialPush(refused(DRIFT), { beforeExit })
    const said = lines.join("\n")
    expect(said).toContain("`supatype dev --overwrite-drift`")
    expect(said).toContain("`supatype push --overwrite-drift`")
    expect(said).toContain("`supatype doctor --rebaseline --accept-access-drift`")
    expect(said).toContain("attendee.attendee_update")
    expect(said).not.toContain('"reason"')
  })

  it("names `supatype push --yes` for a change that would drop data", () => {
    settleInitialPush(refused(DESTRUCTIVE), { beforeExit })
    expect(lines.join("\n")).toContain("`supatype push --yes`")
  })

  it("says a save pushes again, since dev is still watching", () => {
    settleInitialPush(refused(BUSY), { beforeExit })
    expect(lines.join("\n")).toMatch(/save the schema again/)
  })

  it("is applied when the push applied, saying nothing", () => {
    expect(settleInitialPush({ kind: "applied" }, { beforeExit })).toBe(true)
    expect(lines).toEqual([])
  })
})

describe("a first push that leaves nothing for dev to run on", () => {
  it.each([
    ["Postgres never answered", { kind: "exhausted" as const, attempts: 3, message: "the database system is starting up" }],
    ["Docker could not pull the engine's image", refused(PULL_FAILED)],
  ])("still stops dev: %s", (_name, outcome) => {
    expect(() => settleInitialPush(outcome, { beforeExit })).toThrow("exit 1")
    expect(beforeExit).toHaveBeenCalledTimes(1)
  })
})
