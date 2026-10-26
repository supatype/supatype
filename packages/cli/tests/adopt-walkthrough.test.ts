import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * What a push does when the engine refuses tables Supatype does not manage.
 *
 * It used to stop with a message naming `supatype adopt`, a command that could not reach a docker
 * database and found nothing to stamp when it did. Now a terminal is offered adoption there and
 * then, shown the SQL, and asked twice; anywhere else nothing is adopted and the command is
 * printed. These pin that agreeing to a push is never agreeing to adopt.
 */

const printed: string[] = []
vi.mock("../src/ui/messages.js", () => ({
  warn: (line: string) => printed.push(`warn: ${line}`),
  plain: (line?: string) => printed.push(line ?? ""),
}))

let interactive = true
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => interactive }))

const answers: boolean[] = []
vi.mock("../src/ui/confirm.js", () => ({ confirm: vi.fn(async () => answers.shift() ?? false) }))

const { EngineError } = await import("../src/engine-client.js")
const { engineOutputOf, offerAdoption, pushOfferingAdoption, unmanagedTables } = await import(
  "../src/adopt-walkthrough.js"
)

const REFUSAL = '{"status":"refused","reason":"unmanaged_model_tables","tables":["orders","items"]}'
const POLICY = { yes: false, retry: "supatype push" }

function adoptSteps(statements = ['COMMENT ON TABLE "public"."orders" IS ...']) {
  return { preview: vi.fn(async () => statements), apply: vi.fn(async () => statements.length) }
}

beforeEach(() => {
  printed.length = 0
  answers.length = 0
  interactive = true
})
afterEach(() => vi.clearAllMocks())

describe("unmanagedTables()", () => {
  it("reads the tables from the engine's JSON refusal", () => {
    expect(unmanagedTables(`some compose noise\n${REFUSAL}\nError: ...`)).toEqual(["orders", "items"])
  })

  it("falls back to the wording of an engine that predates the JSON", () => {
    const legacy = "Your schema declares model(s) for table(s) Supatype does not manage: public.orders, public.items.\n\nNothing was applied."
    expect(unmanagedTables(legacy)).toEqual(["public.orders", "public.items"])
  })

  it("is null for any other failure, including another JSON refusal", () => {
    expect(unmanagedTables("2 destructive operation(s) detected")).toBeNull()
    expect(unmanagedTables('{"status":"refused","reason":"something_else","tables":["x"]}')).toBeNull()
  })

  it("reads an engine error's stdout, where the refusal is printed", () => {
    const err = new EngineError("Engine /push failed (exit 1): Error: ...", "/push", 1, REFUSAL)
    expect(unmanagedTables(engineOutputOf(err))).toEqual(["orders", "items"])
  })
})

describe("offerAdoption()", () => {
  it("never adopts without a terminal, and prints the command instead", async () => {
    interactive = false
    // Would be yes to both, so only the missing terminal can be what stops it.
    answers.push(true, true)
    const steps = adoptSteps()
    expect(await offerAdoption(["orders"], steps, POLICY)).toBe("declined")
    expect(steps.preview).not.toHaveBeenCalled()
    expect(steps.apply).not.toHaveBeenCalled()
    expect(printed.join("\n")).toContain("Run `supatype adopt`")
  })

  it("never adopts on --yes, because agreeing to a push is not agreeing to adopt", async () => {
    answers.push(true, true)
    const steps = adoptSteps()
    expect(await offerAdoption(["orders"], steps, { ...POLICY, yes: true })).toBe("declined")
    expect(steps.apply).not.toHaveBeenCalled()
  })

  it("says which tables, and that their access rules are not in force", async () => {
    interactive = false
    await offerAdoption(["orders", "items"], adoptSteps(), POLICY)
    expect(printed.join("\n")).toContain("access rules your schema declares for them are not in force: orders, items")
  })

  it("shows the SQL before applying, and applies only on the second yes", async () => {
    answers.push(true, true)
    const steps = adoptSteps()
    expect(await offerAdoption(["orders"], steps, POLICY)).toBe("adopted")
    expect(printed.join("\n")).toContain('COMMENT ON TABLE "public"."orders"')
    expect(steps.apply).toHaveBeenCalledTimes(1)
  })

  it("applies nothing when the SQL is declined", async () => {
    answers.push(true, false)
    const steps = adoptSteps()
    expect(await offerAdoption(["orders"], steps, POLICY)).toBe("declined")
    expect(steps.apply).not.toHaveBeenCalled()
  })

  it("declines, saying so, when the database changed since the preview", async () => {
    answers.push(true, true)
    const steps = adoptSteps()
    steps.apply.mockRejectedValueOnce(
      new EngineError(
        "Engine /adopt failed (exit 1): Error: table:orders was to be adopted but is not a conflict now: " +
          "the database changed since the preview. Nothing was written",
        "/adopt",
        1,
      ),
    )
    expect(await offerAdoption(["orders"], steps, POLICY)).toBe("declined")
    expect(printed.join("\n")).toContain("warn: The database changed since the preview; run `supatype adopt` again.")
  })

  it("throws any other failure to apply as it came", async () => {
    answers.push(true, true)
    const steps = adoptSteps()
    steps.apply.mockRejectedValueOnce(new Error("connection refused"))
    await expect(offerAdoption(["orders"], steps, POLICY)).rejects.toThrow("connection refused")
  })
})

describe("pushOfferingAdoption()", () => {
  it("adopts and pushes once more after an unmanaged-tables refusal", async () => {
    answers.push(true, true)
    const push = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new EngineError("refused", "/push", 1, REFUSAL))
      .mockResolvedValueOnce("applied")
    expect(await pushOfferingAdoption(push, adoptSteps(), POLICY)).toBe("applied")
    expect(push).toHaveBeenCalledTimes(2)
  })

  it("throws the refusal as it came when adoption is declined, so the push still fails", async () => {
    const refusal = new EngineError("refused", "/push", 1, REFUSAL)
    const push = vi.fn<() => Promise<string>>().mockRejectedValue(refusal)
    await expect(pushOfferingAdoption(push, adoptSteps(), POLICY)).rejects.toBe(refusal)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it("does not offer anything for any other failure", async () => {
    const other = new Error("2 destructive operation(s) detected")
    const steps = adoptSteps()
    await expect(pushOfferingAdoption(vi.fn().mockRejectedValue(other), steps, POLICY)).rejects.toBe(other)
    expect(steps.preview).not.toHaveBeenCalled()
  })
})
