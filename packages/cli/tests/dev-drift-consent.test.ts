import { afterEach, describe, expect, it, vi } from "vitest"
import { DEV_DRIFT_KEPT, devPushConsentingToDrift } from "../src/drift-consent.js"
import { pushInitialSchema } from "../src/dev-initial-push.js"
import { EngineError } from "../src/engine-client.js"
import { DevPushDeclined, reportDevPushFailure } from "../src/push-refusal.js"

/**
 * CR1: `supatype dev` met a security-drift refusal with guidance only (`dev --overwrite-drift`),
 * while `push` asked. In a terminal dev now asks the same question, on its first push and on every
 * save, and pushes again with `--overwrite-drift` on a yes. Off a terminal the guidance stays.
 */

const refusal = () =>
  new EngineError(
    "Engine /push failed (exit 1): Error: 1 object(s) that decide who may read or write were changed outside Supatype",
    "/push",
    1,
    JSON.stringify({
      status: "refused",
      reason: "security_drift",
      objects: [{ key: { kind: "policy", schema: "public", parent: "posts", name: "read" }, recorded: "USING (true)", live: "USING (false)" }],
    }),
  )

/** A push the engine refuses for drift unless it is sent `overwrite_drift`. */
function driftedPush() {
  const sent: boolean[] = []
  const push = vi.fn(async (overwrite: boolean) => {
    sent.push(overwrite)
    if (!overwrite) throw refusal()
  })
  return { push, sent }
}

function printed(): () => string {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
  return () => [...log.mock.calls, ...warn.mock.calls, ...err.mock.calls].map((c) => c.join(" ")).join("\n")
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe("devPushConsentingToDrift()", () => {
  it("in a terminal shows what drifted, asks push's question, and on yes pushes with overwrite_drift", async () => {
    const out = printed()
    const { push, sent } = driftedPush()
    const beforeOverwrite = vi.fn(async () => undefined)
    const ask = vi.fn(async () => true)
    await devPushConsentingToDrift(push, false, { ask, beforeOverwrite, interactive: () => true })
    expect(sent).toEqual([false, true])
    expect(ask).toHaveBeenCalledWith("Put Supatype's definitions back?")
    expect(beforeOverwrite).toHaveBeenCalledOnce()
    expect(out()).toContain("policy posts.read")
  })

  it("on no applies nothing and lets dev carry on: no exit code, a DevPushDeclined to report", async () => {
    printed()
    const { push, sent } = driftedPush()
    const declined = devPushConsentingToDrift(push, false, { ask: async () => false, interactive: () => true })
    await expect(declined).rejects.toBeInstanceOf(DevPushDeclined)
    await expect(declined).rejects.toThrow(DEV_DRIFT_KEPT)
    expect(sent).toEqual([false])
    expect(process.exitCode).toBeUndefined()
  })

  it("off a terminal never asks, and the refusal keeps today's guidance", async () => {
    const out = printed()
    const { push } = driftedPush()
    const ask = vi.fn(async () => true)
    let thrown: unknown
    await devPushConsentingToDrift(push, false, { ask, interactive: () => false }).catch((err: unknown) => {
      thrown = err
    })
    expect(thrown).toBeInstanceOf(EngineError)
    expect(ask).not.toHaveBeenCalled()
    reportDevPushFailure(thrown)
    expect(out()).toContain("supatype dev --overwrite-drift")
  })

  it("with dev --overwrite-drift sends it on the first push and asks nothing", async () => {
    const { push, sent } = driftedPush()
    const ask = vi.fn(async () => true)
    await devPushConsentingToDrift(push, true, { ask, interactive: () => true })
    expect(sent).toEqual([true])
    expect(ask).not.toHaveBeenCalled()
  })
})

describe("a declined drift overwrite in dev", () => {
  it("on the first push is neither retried nor fatal: dev comes up on the database as it is", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const steps = {
      push: vi.fn(async () => {
        throw new DevPushDeclined(DEV_DRIFT_KEPT)
      }),
      recoverDatabase: vi.fn(async () => undefined),
      dumpLogs: vi.fn(),
      sleep: vi.fn(async () => undefined),
    }
    expect(await pushInitialSchema(steps)).toEqual({ kind: "declined", message: DEV_DRIFT_KEPT })
    expect(steps.push).toHaveBeenCalledOnce()
    expect(steps.dumpLogs).not.toHaveBeenCalled()
    expect(steps.recoverDatabase).not.toHaveBeenCalled()
  })

  it("on save is reported as what was kept, not as a failed push", () => {
    const out = printed()
    reportDevPushFailure(new DevPushDeclined(DEV_DRIFT_KEPT))
    expect(out()).toContain(DEV_DRIFT_KEPT)
    expect(out()).not.toContain("Schema push failed")
  })
})
