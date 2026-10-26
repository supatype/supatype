import { describe, expect, it } from "vitest"
import { Command } from "commander"
import { registerMigrate, schemaRestoreMode } from "../src/commands/migrate.js"

/**
 * `rollback --no-sync-schema` restored the schema files anyway.
 *
 * Commander turns `--no-sync-schema` into `syncSchema: false`; it never sets `noSyncSchema`. The
 * action read `noSyncSchema`, found it undefined, and offered the restore, which a non-interactive
 * run accepts by default. So the flag meant to keep the files as they are rewrote them.
 */
function rollbackOptions(args: string[]): { syncSchema?: boolean } {
  const program = new Command()
  registerMigrate(program)
  const rollback = program.commands.find((command) => command.name() === "rollback")
  if (rollback === undefined) throw new Error("rollback is not registered")
  rollback.action(() => {})
  program.parse(["node", "supatype", "rollback", ...args])
  return rollback.opts()
}

describe("rollback's schema file restore", () => {
  it("is skipped with --no-sync-schema", () => {
    expect(schemaRestoreMode(rollbackOptions(["--no-sync-schema"]))).toBe("skip")
  })

  it("happens without asking with --sync-schema", () => {
    expect(schemaRestoreMode(rollbackOptions(["--sync-schema"]))).toBe("auto")
  })

  it("is asked about when neither is passed", () => {
    expect(schemaRestoreMode(rollbackOptions([]))).toBe("ask")
  })
})
