import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HOOK_FILES_FEATURE, HOOK_KEEP_FEATURE } from "@supatype/shared"
import { projectConfig } from "./support/project-config.js"

const sent = vi.hoisted(() => ({ bodies: [] as unknown[], refuse: 0, answer: {} as Record<string, unknown>, features: [] as string[] }))
vi.mock("../src/target-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/target-client.js")>()
  return {
    ...actual,
    targetFetch: async (_base: string, _prefix: string, opts: { path: string; body?: unknown }) => {
      // What the target says it supports, asked before a hook upload; not a deploy body.
      if (opts.path.endsWith("/schema/capabilities")) {
        if (sent.features.includes("capabilities-fail")) throw new actual.TargetApiError("Failed to spawn engine", 500)
        if (sent.features.includes("capabilities-404")) throw new actual.TargetApiError("Route not found", 404)
        return { features: sent.features }
      }
      sent.bodies.push(opts.body)
      if (sent.refuse !== 0) throw new actual.TargetApiError("Forbidden", sent.refuse)
      return sent.answer
    },
  }
})

const { deployHooksToTarget, uploadHooks } = await import("../src/commands/push.js")
const { forgetServerCapabilities } = await import("../src/resolve-target.js")

/**
 * The hook deploy body was built differently per target: the maps only for self-host, and nothing at
 * all for a schema with no hooks, so a Cloud project whose schema dropped its last hook kept it. One
 * body now goes to every target, the manifest's three maps in it.
 */
const dirs: string[] = []
afterEach(() => {
  sent.bodies.length = 0
  sent.refuse = 0
  sent.answer = {}
  sent.features = []
  forgetServerCapabilities()
  process.exitCode = undefined
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ast = {
  models: [{ name: "Note", fields: {}, annotations: { db: { tableName: "note" }, platform: { cache: { enabled: true } } } }],
}

describe("the hook deploy body", () => {
  for (const mode of ["cloud", "self-host"] as const) {
    it(`is sent to a ${mode} target with the manifest's maps, though the schema declares no hook`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-body-"))
      dirs.push(cwd)
      vi.spyOn(console, "log").mockImplementation(() => undefined)
      const target = { mode, environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const
      await deployHooksToTarget(cwd, projectConfig(), target, ast)
      expect(sent.bodies).toEqual([{ handlers: [], map: {}, validators: {}, cache: { note: { enabled: true } }, tables: {} }])
    })
  }
})

describe("an empty hook deploy", () => {
  const target = { mode: "cloud", environment: "production", projectRef: "demo", apiBaseUrl: "https://api.example.test", apiPrefix: "/api/v1", token: "key", link: null } as const
  const said: string[] = []

  function project(): string {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-body-"))
    dirs.push(cwd)
    said.length = 0
    for (const stream of ["log", "warn", "error"] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    }
    return cwd
  }

  // Nic's decision (a): a per-machine record of which targets were given hooks missed every target a
  // fresh clone or another machine had deployed to, which kept hooks the schema no longer declares.
  // Every push sends the full body, empty when nothing is declared, so the target holds what the
  // schema says wherever it was pushed from.
  it("is sent from a fresh clone that never deployed, clearing the target's hooks", async () => {
    const cwd = project()
    expect(await deployHooksToTarget(cwd, projectConfig(), target, { models: [] })).toBe(false)
    expect(sent.bodies).toEqual([{ handlers: [], map: {}, validators: {}, cache: {}, tables: {} }])
    expect(said.join("\n")).not.toMatch(/\d+ hook\(s\)/)
  })

  // An empty deploy that clears hooks is a real change, so a refusal of it, 403 included, fails.
  it("fails the push when the target refuses it, 403 included", async () => {
    const cwd = project()
    sent.refuse = 403
    expect(await deployHooksToTarget(cwd, projectConfig(), target, { models: [] })).toBe(true)
    expect(process.exitCode).toBe(1)
  })

  it("says the warning a self-hosted stack answers with, and does not fail", async () => {
    project()
    sent.answer = { warning: "Docker could not be asked whether the functions worker is running: down" }
    expect(await uploadHooks(target, { handlers: [{ name: "h", source: "x" }], map: {} }, 1)).toBe(false)
    expect(said.join("\n")).toContain("Docker could not be asked whether the functions worker is running: down")
    expect(process.exitCode).toBeUndefined()
  })

  it("still fails a hook deploy refused with 403 when it carries hooks", async () => {
    project()
    sent.refuse = 403
    expect(await uploadHooks(target, { handlers: [{ name: "h", source: "x" }], map: {} }, 1)).toBe(true)
    expect(process.exitCode).toBe(1)
  })
})

// Review of round 7, item C6: a hook of more than one file was refused on every target, telling the
// user to run it on a self-hosted stack, which was the target refusing it. A server writes the hook's
// directory back as the project keeps it, so it takes every file; only Supatype Cloud, which serves
// a hook as its one module, refuses, and says what to do instead.
describe("a hook of more than one file", () => {
  const hooked = {
    models: [{ name: "Note", fields: {}, annotations: { db: { tableName: "note" }, platform: { hooks: { beforeChange: { function: "tag-note" } } } } }],
  }
  const said: string[] = []

  function project(): string {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-files-"))
    dirs.push(cwd)
    mkdirSync(join(cwd, "hooks", "tag-note", "lib"), { recursive: true })
    writeFileSync(join(cwd, "hooks", "tag-note", "index.ts"), 'import { tag } from "./lib/tag.ts"\nexport default () => ({ tag })\n')
    writeFileSync(join(cwd, "hooks", "tag-note", "lib", "tag.ts"), 'export const tag = "t"\n')
    said.length = 0
    for (const stream of ["log", "warn", "error"] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    }
    return cwd
  }

  for (const mode of ["self-host", "local"] as const) {
    it(`is sent whole to a ${mode} target that says it takes hook files`, async () => {
      sent.features = [HOOK_FILES_FEATURE]
      const cwd = project()
      const target = { mode, environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const
      expect(await deployHooksToTarget(cwd, projectConfig(), target, hooked)).toBe(false)
      expect(sent.bodies).toMatchObject([{
        handlers: [{
          name: "tag-note",
          files: { "index.ts": 'import { tag } from "./lib/tag.ts"\nexport default () => ({ tag })\n', "lib/tag.ts": 'export const tag = "t"\n' },
        }, { name: "_supatype-hooks" }],
      }])
    })
  }

  // A target that does not list hook_keep takes all or none: a failed hook means none is sent.
  it("is refused for Supatype Cloud, saying what to do, and sends nothing", async () => {
    const cwd = project()
    const target = { mode: "cloud", environment: "production", projectRef: "demo", apiBaseUrl: "https://api.example.test", apiPrefix: "/api/v1", token: "key", link: null } as const
    expect(await deployHooksToTarget(cwd, projectConfig(), target, hooked)).toBe(true)
    expect(sent.bodies).toEqual([])
    const output = said.join("\n")
    expect(output).toContain("Supatype Cloud serves each hook as its one module")
    expect(output).toContain("Move what it needs into hooks/tag-note/index.ts")
  })

  // Review of round 8, item C-2: an older self-hosted control plane dropped `files` without a word
  // and the push reported success. A server that does not say it takes them is sent the entry alone,
  // so a hook of more than one file is refused before anything is sent.
  it("is refused for a server that does not say it takes hook files, and sends nothing", async () => {
    const cwd = project()
    const target = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const
    expect(await deployHooksToTarget(cwd, projectConfig(), target, hooked)).toBe(true)
    expect(sent.bodies).toEqual([])
    expect(said.join("\n")).toContain("has more than one file")
  })

  it("is refused for a server when it imports a file outside its directory, which is not sent", async () => {
    sent.features = [HOOK_FILES_FEATURE]
    const cwd = project()
    writeFileSync(join(cwd, "hooks", "tag-note", "index.ts"), 'import { x } from "../shared/x.ts"\nexport default () => x\n')
    const target = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const
    expect(await deployHooksToTarget(cwd, projectConfig(), target, hooked)).toBe(true)
    expect(sent.bodies).toEqual([])
    expect(said.join("\n")).toContain("../shared/x.ts")
  })
})

// Per-hook deploys, step 4: a target with no capabilities route (404) is an older stack, which takes
// a hook's entry alone. Any other failure to ask is a real error: the hooks are not deployed, and
// the push says why.
describe("a hook upload to a target that cannot say what it takes", () => {
  const said: string[] = []
  function oneHook(): string {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-files-"))
    dirs.push(cwd)
    mkdirSync(join(cwd, "hooks", "tag-note"), { recursive: true })
    writeFileSync(join(cwd, "hooks", "tag-note", "index.ts"), "export default () => ({})\n")
    said.length = 0
    for (const stream of ["log", "warn", "error"] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    }
    return cwd
  }
  const ast = {
    models: [{ name: "Note", fields: {}, annotations: { db: { tableName: "note" }, platform: { hooks: { beforeChange: { function: "tag-note" } } } } }],
  }
  const target = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const

  it("sends a hook of one file as its entry to a stack with no capabilities route", async () => {
    const cwd = oneHook()
    sent.features = ["capabilities-404"]
    expect(await deployHooksToTarget(cwd, projectConfig(), target, ast)).toBe(false)
    expect(sent.bodies).toMatchObject([{ handlers: [{ name: "tag-note" }, { name: "_supatype-hooks" }] }])
    expect(JSON.stringify(sent.bodies)).not.toContain('"files"')
  })

  it("deploys no hook when the stack's capabilities fail, and says why", async () => {
    const cwd = oneHook()
    sent.features = ["capabilities-fail"]
    expect(await deployHooksToTarget(cwd, projectConfig(), target, ast)).toBe(true)
    expect(sent.bodies).toEqual([])
    expect(said.join("\n")).toContain("its hooks were not deployed")
    expect(said.join("\n")).toContain("Failed to spawn engine")
    expect(process.exitCode).toBe(1)
  })
})

// Per-hook deploys (Nic, 2026-11-01): each hook passes or fails on its own. The good ones deploy, a
// failed one is kept on the target, and the push names each, kept or locked, and exits 1.
describe("a push whose hooks partly fail", () => {
  const said: string[] = []
  const twoHooks = {
    models: [
      { name: "Note", fields: {}, annotations: { db: { tableName: "note" }, platform: { hooks: { beforeChange: { function: "good-hook" } } } } },
      { name: "Memo", fields: {}, annotations: { db: { tableName: "memo" }, platform: { hooks: { beforeChange: { function: "bad-hook" } } } } },
    ],
  }
  const target = { mode: "self-host", environment: "production", projectRef: "demo", apiBaseUrl: "https://stack.example.test", apiPrefix: "/platform/v1", token: "key", link: null } as const
  function project(): string {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-hooks-partial-"))
    dirs.push(cwd)
    mkdirSync(join(cwd, "hooks", "good-hook"), { recursive: true })
    writeFileSync(join(cwd, "hooks", "good-hook", "index.ts"), "export default () => ({})\n")
    mkdirSync(join(cwd, "hooks", "bad-hook"), { recursive: true })
    writeFileSync(join(cwd, "hooks", "bad-hook", "index.ts"), 'import { x } from "./x.ts"\nexport default () => x\n')
    writeFileSync(join(cwd, "hooks", "bad-hook", "x.ts"), "export const x = 1\n")
    said.length = 0
    for (const stream of ["log", "warn", "error"] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    }
    return cwd
  }

  it("deploys the good hook, keeps the failed one, and says a new one locks its tables", async () => {
    const cwd = project()
    sent.features = [HOOK_KEEP_FEATURE]
    sent.answer = { handlers: ["good-hook"], tables: ["memo", "note"], locked: ["bad-hook"] }
    expect(await deployHooksToTarget(cwd, projectConfig(), target, twoHooks)).toBe(true)
    expect(sent.bodies).toMatchObject([{ handlers: [{ name: "good-hook" }, { name: "_supatype-hooks" }], keep: ["bad-hook"] }])
    const output = said.join("\n")
    expect(output).toContain("1 hook(s) were not deployed")
    expect(output).toContain("bad-hook")
    expect(output).toContain("writes to memo are refused until it deploys")
    expect(process.exitCode).toBe(1)
  })

  it("says a hook the target refused kept its previous version", async () => {
    const cwd = project()
    writeFileSync(join(cwd, "hooks", "bad-hook", "index.ts"), "export default () => ({})\n")
    sent.features = [HOOK_KEEP_FEATURE]
    sent.answer = { handlers: ["bad-hook"], tables: ["memo", "note"], refused: [{ name: "good-hook", reason: "Hooks: good-hook/index.ts exists and is not a regular file" }], kept: ["good-hook"] }
    expect(await deployHooksToTarget(cwd, projectConfig(), target, twoHooks)).toBe(true)
    const output = said.join("\n")
    expect(output).toContain("good-hook: Hooks: good-hook/index.ts exists and is not a regular file")
    expect(output).toContain("its previous version still runs")
    expect(process.exitCode).toBe(1)
  })

  // Nic: a target that does not list hook_keep keeps the old all-or-nothing deploy.
  it("sends no hook to a target without hook_keep when one fails, and says the previous hooks stay", async () => {
    const cwd = project()
    expect(await deployHooksToTarget(cwd, projectConfig(), target, twoHooks)).toBe(true)
    expect(sent.bodies).toEqual([])
    const output = said.join("\n")
    expect(output).toContain("bad-hook")
    expect(output).toContain("no hooks were sent")
    expect(output).toContain("The hooks deployed before, if any, are still the ones that run.")
    expect(process.exitCode).toBe(1)
  })

  // Nic: onUnavailable "log" lets a write through a hook that cannot be reached; the developer chose
  // it, so the push says so rather than "refused".
  it("says writes go through without a locked hook on a table whose map says log", async () => {
    const cwd = project()
    sent.features = [HOOK_KEEP_FEATURE]
    sent.answer = { handlers: ["good-hook"], tables: ["memo", "note"], locked: ["bad-hook"] }
    const logged = {
      models: [
        twoHooks.models[0]!,
        { name: "Memo", fields: {}, annotations: { db: { tableName: "memo" }, platform: { hooks: { beforeChange: { function: "bad-hook", onUnavailable: "log" } } } } },
      ],
    }
    expect(await deployHooksToTarget(cwd, projectConfig(), target, logged)).toBe(true)
    const output = said.join("\n")
    expect(output).toContain("writes to memo go through without it")
    expect(output).not.toContain("writes to memo are refused")
  })
})
