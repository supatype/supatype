import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkedCapabilities, serverAnswerCapabilities, type EngineProbe } from "../src/engine-ownership-gate.js"
import { schemaEngineImageForPush } from "../src/self-host-compose.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Decision D3, through the capability gate: the pin and the image tag are checked before anything
 * runs, but a tag such as `latest` or `it-r3` names no version, so the engine that answers is asked
 * too, and refused when it reports a version older than 0.8.0, whichever path asked it.
 */
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-engine-baseline-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** An engine answering `capabilities` with `version` and no features, or only `--version` when told. */
function engineReporting(version: string, legacy = false): EngineProbe {
  return (args) => {
    if (args[0] === "capabilities") {
      return legacy ? { status: 2, stdout: "" } : { status: 0, stdout: JSON.stringify({ version, features: [] }) }
    }
    return { status: 0, stdout: `supatype-engine ${version}` }
  }
}

describe("an engine image tagged with no version", () => {
  it("passes the tag pre-check, and is refused when the engine in it reports 0.7.0", async () => {
    const image = "supatype/schema-engine:latest"
    await expect(schemaEngineImageForPush(projectConfig({ provider: "docker" }), dir, { SUPATYPE_ENGINE_IMAGE: image })).resolves.toBe(image)
    expect(() => checkedCapabilities(engineReporting("0.7.0"))).toThrow(/needs Supatype engine 0\.8\.0 or newer.*engine 0\.7\.0/s)
  })

  it("refuses an engine from before `capabilities`, by what --version says", () => {
    expect(() => checkedCapabilities(engineReporting("0.6.0", true))).toThrow(/engine 0\.6\.0/)
  })

  it("lets through a development build of the next release", () => {
    expect(checkedCapabilities(engineReporting("0.8.0-dev+4f2a9c1")).version).toBe("0.8.0-dev+4f2a9c1")
  })
})

describe("a server's capabilities answer", () => {
  it("is refused when it names an engine older than 0.8.0", () => {
    expect(() => serverAnswerCapabilities({ version: "0.7.0", features: [] })).toThrow(/engine 0\.7\.0/)
  })

  it("is taken as it is when it names no version", () => {
    expect(serverAnswerCapabilities({ features: ["release"] }).features).toEqual(new Set(["release"]))
  })
})
