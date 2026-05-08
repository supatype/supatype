import type { Command } from "commander"
import { ensureEngine } from "../engine-client.js"

export function registerPull(program: Command): void {
  program
    .command("pull")
    .description(
      "Introspect an existing Postgres database (deprecated in type-first mode)",
    )
    .action(async () => {
      await ensureEngine()
      throw new Error(
        "The legacy `supatype pull` schema generator has been removed.\n" +
          "Use type-based models with @supatype/types and run `supatype generate`.",
      )
    })
}
