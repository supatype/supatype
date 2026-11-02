import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"

/**
 * `legacyCmd.command("backup", "desc")` declares an executable subcommand in Commander, which
 * returns the parent, so the `.option` and `.action` that followed landed on `self-host native`
 * itself and `self-host native backup` tried to spawn a `supatype-self-host-native-backup` binary.
 * Each native subcommand must own its options and its action.
 */

const ACTION_REACHED = "native action reached loadConfig"

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => {
    throw new Error(ACTION_REACHED)
  },
}))
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  warn: () => undefined,
}))

async function program(): Promise<Command> {
  const { registerSelfHost } = await import("../src/commands/self-host.js")
  const root = new Command("supatype").exitOverride()
  registerSelfHost(root)
  return root
}

function find(parent: Command, name: string): Command {
  const found = parent.commands.find((c) => c.name() === name)
  if (found === undefined) throw new Error(`no ${name} subcommand under ${parent.name()}`)
  return found
}

function optionFlags(cmd: Command): string[] {
  return cmd.options.map((o) => o.long ?? o.flags)
}

describe("self-host native subcommands", () => {
  it.each([
    ["install-service", ["--output-dir", "--user", "--no-enable"]],
    ["serve", ["--port"]],
    ["reload", []],
    ["status", []],
    ["logs", ["--service", "--lines", "--follow"]],
    ["backup", ["--output", "--connection"]],
  ])("%s owns its options and its description", async (name, flags) => {
    const native = find(find(await program(), "self-host"), "native")
    const sub = find(native, name)
    expect(optionFlags(sub)).toEqual(flags)
    expect(sub.description()).not.toBe("")
  })

  it("leaves the parent commands without the subcommands' options", async () => {
    const selfHost = find(await program(), "self-host")
    expect(selfHost.options).toEqual([])
    expect(find(selfHost, "native").options).toEqual([])
  })

  it.each(["install-service", "serve", "reload", "status", "logs", "backup"])(
    "self-host native %s runs its own action",
    async (name) => {
      const root = await program()
      await expect(root.parseAsync(["self-host", "native", name], { from: "user" })).rejects.toThrow(ACTION_REACHED)
    },
  )

  it("self-host native backup --help lists the backup options", async () => {
    const root = await program()
    let out = ""
    const backup = find(find(find(root, "self-host"), "native"), "backup")
    backup.exitOverride().configureOutput({ writeOut: (s) => { out += s } })
    await expect(root.parseAsync(["self-host", "native", "backup", "--help"], { from: "user" })).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    })
    expect(out).toContain("--output <path>")
    expect(out).toContain("Create a Postgres dump")
  })
})
