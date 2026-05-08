import { Command } from "commander"
import { registerInit } from "./commands/init.js"
import { registerDev } from "./commands/dev.js"
import { registerCache } from "./commands/cache.js"
import { registerUpdate } from "./commands/update.js"
import { registerPg } from "./commands/pg.js"
import { registerPush } from "./commands/push.js"
import { registerDiff } from "./commands/diff.js"
import { registerPull } from "./commands/pull.js"
import { registerGenerate } from "./commands/generate.js"
import { registerMigrate } from "./commands/migrate.js"
import { registerSeed } from "./commands/seed.js"
import { registerKeys } from "./commands/keys.js"
import { registerApp } from "./commands/app.js"
import { registerSelfHost } from "./commands/self-host.js"
import { registerCloud } from "./commands/cloud.js"
import { registerEngine } from "./commands/engine.js"
import { registerDb } from "./commands/db.js"
import { registerDeploy } from "./commands/deploy.js"
import { registerStatus } from "./commands/status.js"
import { registerLogs } from "./commands/logs.js"
import { registerAdmin } from "./commands/admin.js"
import { registerFunctions } from "./commands/functions.js"
import { registerPlugins } from "./commands/plugins.js"
import { registerTypes } from "./commands/types.js"
import { registerMigrateFromV1 } from "./commands/migrate-from-v1.js"

export function run(): void {
  const program = new Command()
    .name("supatype")
    .description("Supatype — schema-first Postgres API")
    .version("0.1.0")

  registerInit(program)
  registerDev(program)
  registerCache(program)
  registerUpdate(program)
  registerPg(program)
  registerPush(program)
  registerDiff(program)
  registerPull(program)
  registerGenerate(program)
  registerMigrate(program)
  registerSeed(program)
  registerKeys(program)
  registerApp(program)
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

  program.parse()
}
