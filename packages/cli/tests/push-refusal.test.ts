import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * One reading of a refused push for every path that pushes (C02, C07, C14 in the pre-launch
 * verification). The engine names its refusals by code (`security_drift`, `engine_busy`), and the
 * CLI says what to do about each in its own words, whichever path the push took: dev's first push,
 * a hot reload, `push` through Docker, a linked or self-hosted target.
 */

const lines: string[] = []
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  error: (line: string) => lines.push(`error: ${line}`),
  warn: (line: string) => lines.push(`warn: ${line}`),
  plain: (line?: string) => lines.push(line ?? ""),
  info: (line: string) => lines.push(`info: ${line}`),
}))

const { EngineError, engineBusyMessage } = await import("../src/engine-client.js")
const { ENGINE_BUSY, isJsonObject } = await import("@supatype/shared")
const { TargetApiError } = await import("../src/target-client.js")
const { isEngineBusy } = await import("../src/adopt-walkthrough.js")
const { exitInitialPushFailed, pushInitialSchema } = await import("../src/dev-initial-push.js")
const { parseJsonAs } = await import("./support/json.js")
/** Imported per test, so the paths that exist on the base still run without the new module. */
const refusal = () => import("../src/push-refusal.js")

/** The engine's sentence today (schema-engine `push::EngineBusy`). */
const BUSY_SENTENCE =
  "another push, adopt, rebaseline or rollback is running on this database; try again. Nothing was applied."
const BUSY_JSON = JSON.stringify({ status: "refused", reason: "engine_busy", message: BUSY_SENTENCE })
const DRIFT_JSON = JSON.stringify({
  status: "refused",
  reason: "security_drift",
  objects: [{ key: { kind: "policy", schema: "public", parent: "post", name: "post_select" }, recorded: "USING (true)", live: "USING (false)" }],
})
const DRIFT_STDERR =
  "Error: 1 object(s) that decide who may read or write were changed outside Supatype; pass --overwrite-drift to put Supatype's definitions back."
/** What `docker compose run` printed when the engine image could not be pulled (C14). */
const PULL_FAILED =
  'Error response from daemon: failed to resolve reference "docker.io/supatype/schema-engine:verify-a5-late": ' +
  "docker.io/supatype/schema-engine:verify-a5-late: not found"

/** A compose push failure as `runComposeSchemaPush` throws it: stdout's JSON line, then stderr. */
const composeFailure = (json: string, stderr: string): Error => new Error(`${json}\n${stderr}`)

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
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")))
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")))
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("C07: engine_busy, by code first and the engine's current sentence second", () => {
  it("reads the engine's current sentence on stderr when there is no JSON line", () => {
    expect(engineBusyMessage("", `Error: ${BUSY_SENTENCE}`)).toMatch(/^Another push, adopt, rebaseline or rollback is running/)
  })

  it("is busy for a server's 409 with the current sentence and no code", () => {
    expect(isEngineBusy(new TargetApiError(BUSY_SENTENCE, 409))).toBe(true)
  })

  it("is busy for the docker path's plain error, by the JSON reason or by the sentence", () => {
    expect(isEngineBusy(composeFailure(BUSY_JSON, `Error: ${BUSY_SENTENCE}`))).toBe(true)
    expect(isEngineBusy(new Error(`Error: ${BUSY_SENTENCE}`))).toBe(true)
    expect(isEngineBusy(new Error("Error: relation \"post\" does not exist"))).toBe(false)
  })
})

describe("C02: dev's first push", () => {
  it("security_drift is its own refusal, and dev names `supatype dev --overwrite-drift`", async () => {
    const outcome = await pushInitialSchema(steps([`${DRIFT_JSON}\n${DRIFT_STDERR}`]))
    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "security-drift" } })
    if (outcome.kind === "applied") throw new Error("the push was applied")
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })
    expect(() => exitInitialPushFailed(outcome)).toThrow("exit")
    expect(exit).toHaveBeenCalledWith(1)
    const said = lines.join("\n")
    expect(said).toContain("`supatype dev --overwrite-drift`")
    expect(said).toContain("policy post.post_select")
    expect(said).not.toContain("Fix the schema")
  })

  it("engine_busy is its own refusal, never retried as a database problem, and says to try again", async () => {
    const s = steps([`${BUSY_JSON}\nError: ${BUSY_SENTENCE}`])
    const outcome = await pushInitialSchema(s)
    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "engine-busy" } })
    expect(s.recoverDatabase).not.toHaveBeenCalled()
    if (outcome.kind === "applied") throw new Error("the push was applied")
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })
    expect(() => exitInitialPushFailed(outcome)).toThrow("exit")
    const said = lines.join("\n")
    expect(said).toMatch(/another push is running/i)
    expect(said).toMatch(/try again/i)
    expect(said).not.toContain("Fix the schema")
  })
})

describe("C02, C14: a hot reload's failed push", () => {
  it("security_drift: the objects and `supatype dev --overwrite-drift`, not the raw JSON", async () => {
    ;(await refusal()).reportDevPushFailure(composeFailure(DRIFT_JSON, DRIFT_STDERR))
    const said = lines.join("\n")
    expect(said).toContain("`supatype dev --overwrite-drift`")
    expect(said).toContain("policy post.post_select")
    expect(said).not.toContain('"reason"')
  })

  it("engine_busy: another push is running, try again", async () => {
    ;(await refusal()).reportDevPushFailure(composeFailure(BUSY_JSON, `Error: ${BUSY_SENTENCE}`))
    const said = lines.join("\n")
    expect(said).toMatch(/another push is running/i)
    expect(said).toMatch(/save the schema again|try again/i)
    expect(said).not.toContain('"reason"')
  })

  it("an image Docker could not pull: Docker could not pull, and not the schema's fault", async () => {
    ;(await refusal()).reportDevPushFailure(new Error(PULL_FAILED))
    const said = lines.join("\n")
    expect(said).toContain("Docker could not pull")
    expect(said).toContain("supatype/schema-engine:verify-a5-late")
  })
})

describe("classifyPushRefusal(): code first, wording second", () => {
  it("reads each refusal from the engine binary, a server's 409 and the docker path alike", async () => {
    expect((await refusal()).classifyPushRefusal(new EngineError(BUSY_SENTENCE, "/push", 1, BUSY_JSON, ENGINE_BUSY))?.kind).toBe("engine-busy")
    expect((await refusal()).classifyPushRefusal(new EngineError("Engine /push failed (exit 1): x", "/push", 1, DRIFT_JSON))?.kind).toBe("security-drift")
    const http = new TargetApiError("1 object(s) ... changed outside Supatype", 409, "security_drift", parseJsonAs(DRIFT_JSON, isJsonObject))
    const drift = (await refusal()).classifyPushRefusal(http)
    expect(drift?.kind === "security-drift" && drift.objects.map((o) => o.key.name)).toEqual(["post_select"])
    expect((await refusal()).classifyPushRefusal(new Error(PULL_FAILED))?.kind).toBe("image-pull")
    expect((await refusal()).classifyPushRefusal(new Error("2 destructive operation(s) detected"))?.kind).toBe("destructive")
    expect((await refusal()).classifyPushRefusal(new Error("relation does not exist"))).toBeNull()
  })

  it("a code wins over wording that looks like another refusal", async () => {
    // The drift refusal's prose names --overwrite-drift; the JSON line is what decides.
    const err = composeFailure(DRIFT_JSON, "toomanyrequests: rate limit")
    expect((await refusal()).classifyPushRefusal(err)?.kind).toBe("security-drift")
  })
})

describe("C14: `supatype push` with an image Docker could not pull", () => {
  it("says Docker could not pull it, names the image, and that the schema was never read", async () => {
    const text = await explained(new Error(PULL_FAILED), "supatype push")
    expect(text).toContain("Docker could not pull")
    expect(text).toContain("supatype/schema-engine:verify-a5-late")
    expect(text).toMatch(/not a problem with your schema/)
  })

  it("engine_busy on `push`: another push is running, try again", async () => {
    const text = await explained(composeFailure(BUSY_JSON, `Error: ${BUSY_SENTENCE}`), "supatype push")
    expect(text).toMatch(/another push is running.*try again/is)
  })
})

/** What `command` says about `err`, headline and hints together. */
async function explained(err: unknown, command: string): Promise<string> {
  const { classifyPushRefusal, explainRefusal } = await refusal()
  const found = classifyPushRefusal(err)
  expect(found).not.toBeNull()
  const { headline, hints } = explainRefusal(found!, { command })
  return [headline, ...hints].join("\n")
}

describe("a server's busy sentence counts only on a 409", () => {
  it("is busy on a 409 and not on a 500 or a proxy page that echoes the sentence", async () => {
    const { classifyPushRefusal } = await refusal()
    expect(classifyPushRefusal(new TargetApiError(BUSY_SENTENCE, 409))?.kind).toBe("engine-busy")
    expect(classifyPushRefusal(new TargetApiError(`upstream said: ${BUSY_SENTENCE}`, 500))).toBeNull()
    expect(classifyPushRefusal(new TargetApiError(BUSY_SENTENCE, 502))).toBeNull()
    expect(isEngineBusy(new TargetApiError(BUSY_SENTENCE, 500))).toBe(false)
  })
})

describe("explainingRefusal()", () => {
  const UNMANAGED_JSON = JSON.stringify({ status: "refused", reason: "unmanaged_model_tables", tables: ["orders"] })

  it("explains an unmanaged-tables refusal for a command with no adoption walkthrough (deploy)", async () => {
    const { explainingRefusal } = await refusal()
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit")
    })
    const failing = () => Promise.reject(composeFailure(UNMANAGED_JSON, "Error: declares model(s)"))
    await expect(explainingRefusal("supatype deploy", failing)).rejects.toThrow("exit")
    const said = lines.join("\n")
    expect(said).toContain("Supatype did not create them: orders")
    expect(said).toContain("run `supatype deploy` again")
    expect(said).not.toContain('"reason"')
  })

  it("rethrows, as it came, a refusal the command says it has already explained (push)", async () => {
    const { explainingRefusal } = await refusal()
    const err = composeFailure(UNMANAGED_JSON, "Error: declares model(s)")
    await expect(explainingRefusal("supatype push", () => Promise.reject(err), ["unmanaged-tables"])).rejects.toBe(err)
  })

  it("names the command's own way to apply a destructive change", async () => {
    const text = await explained(new Error("Error: 2 destructive operation(s) detected"), "supatype deploy")
    expect(text).toContain("`supatype deploy --yes`")
  })
})

describe("drift_changed: a rebaseline refused because the drift moved after its preview (C04, F29)", () => {
  const CHANGED = {
    status: "refused",
    reason: "drift_changed",
    unseen: ["policy:tag.tag_select"],
    gone: ["check:posts.posts_title_bounds"],
    message: "The drift changed after the preview, so nothing was rebaselined.",
  }

  it("is read by code from the binary's line, a server's 409 body, and the docker path", async () => {
    const { classifyPushRefusal } = await refusal()
    const fromBinary = classifyPushRefusal(new EngineError("Engine /doctor failed (exit 1): x", "/doctor", 1, JSON.stringify(CHANGED)))
    expect(fromBinary).toEqual({ kind: "drift-changed", unseen: ["policy:tag.tag_select"], gone: ["check:posts.posts_title_bounds"] })
    const { status: _status, ...body } = CHANGED
    const fromServer = classifyPushRefusal(new TargetApiError(CHANGED.message, 409, undefined, { error: CHANGED.message, ...body }))
    expect(fromServer).toEqual(fromBinary)
    expect(classifyPushRefusal(composeFailure(JSON.stringify(CHANGED), `Error: ${CHANGED.message}`))).toEqual(fromBinary)
  })

  it("is read by the engine's sentence from a server that passed on the reason alone", async () => {
    const { classifyPushRefusal } = await refusal()
    expect(classifyPushRefusal(new TargetApiError("The drift changed after the preview, so nothing was rebaselined.", 409))).toEqual({
      kind: "drift-changed",
      unseen: [],
      gone: [],
    })
  })

  it("says what is new, what is gone, that nothing was recorded, and to run doctor again", async () => {
    const text = await explained(new EngineError("x", "/doctor", 1, JSON.stringify(CHANGED)), "supatype doctor --rebaseline")
    expect(text).toContain("The drift changed after the preview, so nothing was recorded.")
    expect(text).toContain("New since the preview: policy:tag.tag_select")
    expect(text).toContain("No longer drifted: check:posts.posts_title_bounds")
    expect(text).toContain("Run `supatype doctor --rebaseline` again to review the drift as it is now.")
  })
})
