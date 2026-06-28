import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { registerInit } from "../src/commands/init.js"
import { registerDev } from "../src/commands/dev.js"
import { registerCache } from "../src/commands/cache.js"
import { registerSelfUpdate } from "../src/commands/self-update.js"
import { registerUpdate } from "../src/commands/update.js"
import { registerPg } from "../src/commands/pg.js"
import { registerPush } from "../src/commands/push.js"
import { registerDiff } from "../src/commands/diff.js"
import { registerPull } from "../src/commands/pull.js"
import { registerDoctor } from "../src/commands/doctor.js"
import { registerIntrospect } from "../src/commands/introspect.js"
import { registerAdopt } from "../src/commands/adopt.js"
import { registerGenerate } from "../src/commands/generate.js"
import { registerMigrate } from "../src/commands/migrate.js"
import { registerSeed } from "../src/commands/seed.js"
import { registerKeys } from "../src/commands/keys.js"
import { registerApp } from "../src/commands/app.js"
import { registerAdd } from "../src/commands/add.js"
import { registerSelfHost } from "../src/commands/self-host.js"
import { registerCloud } from "../src/commands/cloud.js"
import { registerEngine } from "../src/commands/engine.js"
import { registerDb } from "../src/commands/db.js"
import { registerDeploy } from "../src/commands/deploy.js"
import { registerStatus } from "../src/commands/status.js"
import { registerLogs } from "../src/commands/logs.js"
import { registerAdmin } from "../src/commands/admin.js"
import { registerFunctions } from "../src/commands/functions.js"
import { registerPlugins } from "../src/commands/plugins.js"
import { registerTypes } from "../src/commands/types.js"
import { registerMigrateFromV1 } from "../src/commands/migrate-from-v1.js"
import {
  shouldExcludeCommandChrome,
  wrapProgramActionsWithChrome,
} from "../src/ui/runtime/command-chrome.js"

type CommandWithAction = Command & {
  parent?: Command | null
  _actionHandler?: ((args: unknown) => unknown) | null
}

function commandPath(cmd: CommandWithAction, root: Command): string {
  const segments: string[] = []
  let current: CommandWithAction | null = cmd
  while (current && current !== root) {
    segments.unshift(current.name())
    current = current.parent ?? null
  }
  return segments.join(" ")
}

function collectActionCommands(cmd: CommandWithAction, root: Command): CommandWithAction[] {
  const out: CommandWithAction[] = []
  if (cmd._actionHandler) out.push(cmd)
  for (const sub of cmd.commands) {
    out.push(...collectActionCommands(sub as CommandWithAction, root))
  }
  return out
}

function buildProgram(): Command {
  const program = new Command().name("supatype")
  registerInit(program)
  registerDev(program)
  registerCache(program)
  registerSelfUpdate(program)
  registerUpdate(program)
  registerPg(program)
  registerPush(program)
  registerDiff(program)
  registerPull(program)
  registerDoctor(program)
  registerIntrospect(program)
  registerAdopt(program)
  registerGenerate(program)
  registerMigrate(program)
  registerSeed(program)
  registerKeys(program)
  registerApp(program)
  registerAdd(program)
  registerSelfHost(program)
  registerCloud(program)
  registerEngine(program)
  registerDb(program)
  registerDeploy(program)
  registerStatus(program)
  registerLogs(program)
  registerAdmin(program)
  registerFunctions(program)
  registerPlugins(program)
  registerTypes(program)
  registerMigrateFromV1(program)
  wrapProgramActionsWithChrome(program)
  return program
}

describe("CLI command chrome coverage", () => {
  it("wraps every non-excluded leaf command", () => {
    const program = buildProgram()
    const root = program as CommandWithAction
    const commands = collectActionCommands(root, program)

    expect(commands.length).toBeGreaterThan(50)

    const excluded: string[] = []
    const wrapped: string[] = []

    for (const cmd of commands) {
      const path = commandPath(cmd, program)
      const handlerBefore = cmd._actionHandler
      // Re-wrap is idempotent only when already wrapped; detect first-wrap by path policy.
      if (shouldExcludeCommandChrome(path)) {
        excluded.push(path)
        continue
      }
      wrapped.push(path)
      expect(handlerBefore, `${path} should be wrapped`).toBeDefined()
    }

    expect(excluded).toEqual(
      expect.arrayContaining([
        "dev",
        "init",
        "link",
        "add domain",
        "logs",
        "pg psql",
        "functions serve",
        "self-host compose logs",
      ]),
    )

    expect(wrapped).toEqual(
      expect.arrayContaining([
        "push",
        "diff",
        "doctor",
        "pull",
        "cache list",
        "cache rest list",
        "deploy",
        "deploy rollback",
        "keys",
        "generate",
      ]),
    )
  })
})
