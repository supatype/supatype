import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runSchemaPush } from "../src/commands/dev.js"
import { assertRealtimeSupportsSchema, REALTIME_MIN_FOR_CHANNELS } from "../src/engine-floor.js"
import { errorMessage } from "../src/error-message.js"
import type { ExtractedChannelAst, ExtractedSchemaAstV2 } from "../src/schema-ast-v2.js"
import { projectConfig } from "./support/project-config.js"

/**
 * FF-34 (2026-11-23 e2e run): native dev ran a realtime that predates private channels, the schema
 * declared them, and every join answered `unsupported_server` while push said nothing. Only the
 * realtime server enforces a channel, so a pinned one that is too old is refused up front, as an
 * engine that would drop `channels` is.
 */
const NO_CHANNELS: ExtractedSchemaAstV2 = { astVersion: 2, models: [] }
const CHANNEL: ExtractedChannelAst = {
  name: "LotChannel",
  pattern: "lot:{id}",
  params: [{ name: "id", type: "uuid" }],
  access: { join: { type: "authenticated" }, send: null, track: null },
}
const WITH_CHANNEL: ExtractedSchemaAstV2 = { astVersion: 2, models: [], channels: [CHANNEL] }
const WITH_MODE: ExtractedSchemaAstV2 = { astVersion: 2, models: [], realtime: { channels: "declared" } }

describe("the realtime channels floor", () => {
  it("refuses a pinned realtime older than the floor, naming the channel and the pin", () => {
    for (const ast of [WITH_CHANNEL, WITH_MODE]) {
      try {
        assertRealtimeSupportsSchema(ast, "0.9.2")
        expect.unreachable("channels on an older realtime have to be refused")
      } catch (err) {
        const message = errorMessage(err)
        expect(message).toContain("realtime channels")
        expect(message).toContain(`realtime ${REALTIME_MIN_FOR_CHANNELS} or newer`)
        expect(message).toContain("pins 0.9.2")
        expect(message).toContain("versions: { realtime:")
      }
    }
  })

  it("allows a schema with no channels on any pin", () => {
    expect(() => { assertRealtimeSupportsSchema(NO_CHANNELS, "0.1.0") }).not.toThrow()
  })

  it("allows the floor itself, unpinned and local", () => {
    for (const pin of [REALTIME_MIN_FOR_CHANNELS, "0.10.0", undefined, "local"]) {
      expect(() => { assertRealtimeSupportsSchema(WITH_CHANNEL, pin) }).not.toThrow()
    }
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("native dev's schema push", () => {
  it("refuses channels on a pinned realtime older than the floor, before any engine runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-dev-rt-floor-"))
    dirs.push(cwd)
    mkdirSync(join(cwd, ".supatype"), { recursive: true })
    const schemaPath = join(cwd, "schema.ts")
    writeFileSync(
      schemaPath,
      [
        `import type { Model, UUID, Channel, LoggedIn } from "@supatype/types"`,
        `export type Lot = Model<{ id: UUID }, { access: { read: LoggedIn } }>`,
        `export type Lobby = Channel<"lobby", { access: { join: LoggedIn } }>`,
        ``,
      ].join("\n"),
      "utf8",
    )
    const config = projectConfig({ project: { name: "p" }, database: { provider: "native" }, versions: { realtime: "0.9.2" } })
    await expect(
      runSchemaPush({ cwd, engineBin: "/nonexistent/engine", schemaPath, dbURL: "postgres://x", config }),
    ).rejects.toThrow(/realtime channels, which needs realtime .* or newer, and this project pins 0\.9\.2/)
  })
})
