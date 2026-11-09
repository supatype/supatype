import { Command, CommanderError } from "commander"
import { describe, expect, it } from "vitest"
import { registerSelfHost } from "../src/commands/self-host.js"

/**
 * 0.9.2: the hidden `self-host native` group is gone. It was undocumented and untested, Docker
 * Compose is the self-host path, and its `serve` ran supatype-server on the server's built-in
 * object store, which applies no storage read rules: anyone with the anon key could read a
 * private bucket. The systemd units its `install-service` wrote started no storage service either.
 */

function program(): Command {
  const root = new Command("supatype").exitOverride()
  registerSelfHost(root)
  root.commands.forEach((c) => c.exitOverride().configureOutput({ writeErr: () => undefined }))
  return root
}

describe("self-host", () => {
  it("has no native subcommand", () => {
    const selfHost = program().commands.find((c) => c.name() === "self-host")
    expect(selfHost?.commands.map((c) => c.name())).toEqual(["compose"])
  })

  it.each(["serve", "install-service", "reload", "status", "logs", "backup"])(
    "refuses `self-host native %s` as an unknown command",
    async (name) => {
      const run = program().parseAsync(["self-host", "native", name], { from: "user" })
      await expect(run).rejects.toBeInstanceOf(CommanderError)
      await expect(run).rejects.toMatchObject({ code: "commander.unknownCommand" })
    },
  )
})
