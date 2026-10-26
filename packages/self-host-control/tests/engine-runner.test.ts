import { strict as assert } from "node:assert"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { test, describe, afterEach } from "node:test"
import { EngineRunError, engineRefusal, resetEngineCapabilities, runEngineCapabilities } from "../src/engine-runner.js"

const MOCK_ENGINE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-engine.mjs")

/** The engine's sentence today (schema-engine `push::EngineBusy`). */
const BUSY = "another push, adopt, rebaseline or rollback is running on this database; try again. Nothing was applied."

describe("engineRefusal() (C07)", () => {
  test("reads the engine's current busy sentence when stdout has no JSON line", () => {
    const refusal = engineRefusal(new EngineRunError("Engine exit 1", 1, "", `2026-10-10 INFO x\nError: ${BUSY}\n`))
    assert.equal(refusal?.reason, "engine_busy")
    assert.equal(refusal?.message, BUSY)
  })

  test("still reads the wording from before rollback took the lock", () => {
    const old = "Error: another push, adopt or rebaseline is running on this database; try again."
    assert.equal(engineRefusal(new EngineRunError("Engine exit 1", 1, "", old))?.reason, "engine_busy")
  })
})

describe("runEngineCapabilities() (C03)", () => {
  afterEach(() => {
    delete process.env["SUPATYPE_ENGINE_MOCK"]
    delete process.env["SUPATYPE_ENGINE_BIN"]
    resetEngineCapabilities()
  })

  test("a probe that could not run the engine is not remembered", async () => {
    resetEngineCapabilities()
    process.env["SUPATYPE_ENGINE_BIN"] = join(dirname(MOCK_ENGINE), "does-not-exist")
    await assert.rejects(runEngineCapabilities(), /spawn engine/)
    process.env["SUPATYPE_ENGINE_MOCK"] = MOCK_ENGINE
    const answer = await runEngineCapabilities()
    assert.ok(answer.features.includes("adopt_none"), JSON.stringify(answer))
  })
})
