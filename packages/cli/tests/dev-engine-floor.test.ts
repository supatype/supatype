import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runSchemaPush } from "../src/commands/dev.js"
import { ENGINE_MIN_FOR_CHANNELS } from "../src/engine-floor.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { selfHostComposePaths } from "../src/self-host-compose.js"
import { projectConfig } from "./support/project-config.js"

/**
 * `supatype push` refuses a schema the pinned engine would silently drop part of. `supatype dev`
 * applies schemas too, and skipped that check: a pinned old engine accepted `channels` and enforced
 * nothing. Dev now runs the same floor check before it applies a schema.
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SCHEMA = [
  `import type { Model, UUID, Channel, LoggedIn } from "@supatype/types"`,
  `export type Lot = Model<{ id: UUID }, { access: { read: LoggedIn } }>`,
  `export type Lobby = Channel<"lobby", { access: { join: LoggedIn } }>`,
  ``,
].join("\n")

function project(engine: string): { cwd: string; schemaPath: string; config: SupatypeProjectConfig } {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-dev-floor-"))
  dirs.push(cwd)
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  const schemaPath = join(cwd, "schema.ts")
  writeFileSync(schemaPath, SCHEMA, "utf8")
  const config = projectConfig({ project: { name: "p" }, database: { provider: "native" }, versions: { engine } })
  return { cwd, schemaPath, config }
}

describe("dev's schema push", () => {
  it("refuses channels on a pinned engine older than the floor, before any engine runs", async () => {
    const { cwd, schemaPath, config } = project("0.1.9")
    await expect(
      runSchemaPush({ cwd, engineBin: "/nonexistent/engine", schemaPath, dbURL: "postgres://x", config }),
    ).rejects.toThrow(/realtime channels, which needs schema-engine .* or newer, and this project pins 0\.1\.9/)
  })
})

describe("docker dev's schema push", () => {
  it("refuses channels on a pinned engine older than the floor, before the AST file or any compose call", async () => {
    const { runComposeSchemaPush } = await import("../src/dev-compose.js")
    const { cwd, schemaPath, config } = project("0.1.9")
    const paths = selfHostComposePaths(cwd)
    await expect(runComposeSchemaPush(cwd, config, paths, schemaPath, "p")).rejects.toThrow(
      /realtime channels, which needs schema-engine .* or newer, and this project pins 0\.1\.9/,
    )
    expect(existsSync(join(cwd, ".supatype", "schema.ast.json"))).toBe(false)
  })

  it("lets a pin at the floor through that check", async () => {
    const { schemaChangedSinceLastPush } = await import("../src/dev-compose.js")
    const { cwd, schemaPath, config } = project(ENGINE_MIN_FOR_CHANNELS)
    expect(() => schemaChangedSinceLastPush(schemaPath, cwd, config)).not.toThrow()
  })
})
