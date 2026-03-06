import { Command } from "commander"
import { ENGINE_VERSION } from "./engine-version.js"
import { registerInit } from "./commands/init.js"
import { registerDev } from "./commands/dev.js"
import { registerPush } from "./commands/push.js"
import { registerDiff } from "./commands/diff.js"
import { registerPull } from "./commands/pull.js"
import { registerGenerate } from "./commands/generate.js"
import { registerMigrate } from "./commands/migrate.js"
import { registerSeed } from "./commands/seed.js"

export function run(): void {
  const program = new Command()
    .name("supatype")
    .description("Definatype — schema-first Postgres API")
    .version(ENGINE_VERSION)

  registerInit(program)
  registerDev(program)
  registerPush(program)
  registerDiff(program)
  registerPull(program)
  registerGenerate(program)
  registerMigrate(program)
  registerSeed(program)

  program.parse()
}
