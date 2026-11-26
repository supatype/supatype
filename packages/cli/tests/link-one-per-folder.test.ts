import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A folder holds one link. A second `link` to a different project, or to the other kind of host,
 * used to merge into the first and damage it silently (E2E round 5, FF-6). It now refuses, naming
 * the link that is there, unless `--force` writes a fresh one. `supatype unlink` removes it.
 */
const said = vi.hoisted(() => ({ errors: [] as string[], infos: [] as string[], plains: [] as string[] }))

vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  error: (m: string) => said.errors.push(m),
  info: (m: string) => said.infos.push(m),
  plain: (m?: string) => said.plains.push(m ?? ""),
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => ({ project: { name: "demo" } }),
}))
vi.mock("../src/target-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/target-client.js")>()),
  targetFetch: async (_url: string, _prefix: string, req: { path: string }) => {
    if (req.path === "/project") return { ref: "selfref" }
    if (req.path.endsWith("/environments")) return []
    if (/^\/projects\/[^/]+$/.test(req.path)) return { slug: req.path.slice("/projects/".length), orgId: "org1" }
    return {}
  },
}))
vi.mock("../src/cloud-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cloud-credentials.js")>()),
  loadCloudCredentials: () => null,
  envAccessToken: () => undefined,
}))

import { registerCloud } from "../src/commands/cloud.js"
import {
  createCloudLink,
  createSelfHostLink,
  LinkConflictError,
  loadProjectLink,
  saveProjectLink,
  LEGACY_CLOUD_FILE,
  LEGACY_LINKED_FILE,
  LINK_FILE,
} from "../src/link.js"
import { exitThrows } from "./support/process-exit.js"

let dir: string

const cloudBase = { projectRef: "alpha", cloudApiUrl: "https://api.example.com", token: "tok" }
const selfBase = { projectRef: "selfref", apiUrl: "http://kong.test", token: "srk" }

async function run(args: string[]): Promise<string> {
  const program = new Command().exitOverride()
  registerCloud(program)
  try {
    await program.parseAsync(["node", "supatype", ...args])
    return ""
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-link-one-"))
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  vi.spyOn(process, "cwd").mockReturnValue(dir)
  said.errors.length = 0
  said.infos.length = 0
  said.plains.length = 0
  exitThrows()
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("createCloudLink and createSelfHostLink", () => {
  it("refuse a different project, naming the link that is there", () => {
    const existing = createCloudLink(cloudBase)
    expect(() => createCloudLink({ ...cloudBase, projectRef: "beta", existing })).toThrow(LinkConflictError)
    expect(() => createCloudLink({ ...cloudBase, projectRef: "beta", existing })).toThrow(/Supatype Cloud project "alpha"/)
    expect(() => createCloudLink({ ...cloudBase, projectRef: "beta", existing })).toThrow(/supatype unlink.*--force/)
  })

  it("refuse the other kind of host", () => {
    const cloud = createCloudLink(cloudBase)
    expect(() => createSelfHostLink({ ...selfBase, existing: cloud })).toThrow(/Supatype Cloud project "alpha"/)
    const self = createSelfHostLink(selfBase)
    expect(() => createCloudLink({ ...cloudBase, existing: self })).toThrow(/self-host project "selfref"/)
  })

  it("keep a same-project relink working: a self-host environment is added", () => {
    const existing = createSelfHostLink(selfBase)
    const added = createSelfHostLink({ ...selfBase, envName: "staging", apiUrl: "http://stg.test", existing })
    expect(Object.keys(added.environments).sort()).toEqual(["production", "staging"])
  })

  it("keep a same-project cloud relink working", () => {
    const existing = createCloudLink({ ...cloudBase, refreshToken: "r1" })
    const again = createCloudLink({ ...cloudBase, token: "tok2", existing })
    expect(again.token).toBe("tok2")
    expect(again.refreshToken).toBe("r1")
  })

  it("write a fresh link under force, carrying nothing over", () => {
    const existing = createCloudLink({ ...cloudBase, refreshToken: "r1" })
    const fresh = createSelfHostLink({ ...selfBase, existing, force: true })
    expect(fresh.kind).toBe("self-host")
    expect(fresh.projectRef).toBe("selfref")
    expect(Object.keys(fresh.environments)).toEqual(["production"])
    expect(fresh.refreshToken).toBeUndefined()
    const other = createCloudLink({ ...cloudBase, projectRef: "beta", existing, force: true })
    expect(Object.keys(other.environments)).toEqual(["production"])
    expect(other.refreshToken).toBeUndefined()
  })
})

describe("supatype link", () => {
  it("refuses a second project and leaves the first link as it was", async () => {
    saveProjectLink(dir, createCloudLink(cloudBase))
    const before = readFileSync(join(dir, LINK_FILE), "utf8")
    const out = await run(["link", "--project", "beta", "--token", "tok"])
    expect(out).toBe("exit 1")
    expect(said.errors.join("\n")).toMatch(/Supatype Cloud project "alpha"/)
    expect(said.errors.join("\n")).toMatch(/supatype unlink/)
    expect(said.errors.join("\n")).toMatch(/--force/)
    expect(readFileSync(join(dir, LINK_FILE), "utf8")).toBe(before)
  })

  it("refuses a self-host link over a Cloud one", async () => {
    saveProjectLink(dir, createCloudLink(cloudBase))
    expect(await run(["link", "--url", "http://kong.test", "--token", "srk"])).toBe("exit 1")
    expect(loadProjectLink(dir)?.kind).toBe("cloud")
  })

  it("replaces the link under --force", async () => {
    saveProjectLink(dir, createCloudLink(cloudBase))
    expect(await run(["link", "--url", "http://kong.test", "--token", "srk", "--force"])).toBe("")
    const link = loadProjectLink(dir)
    expect(link?.kind).toBe("self-host")
    expect(link?.projectRef).toBe("selfref")
    expect(Object.keys(link?.environments ?? {})).toEqual(["production"])
  })

  it("adds an environment to the same project without --force", async () => {
    saveProjectLink(dir, createSelfHostLink(selfBase))
    expect(await run(["link", "--url", "http://stg.test", "--token", "srk", "--env", "staging"])).toBe("")
    expect(Object.keys(loadProjectLink(dir)?.environments ?? {}).sort()).toEqual(["production", "staging"])
  })
})

describe("supatype unlink", () => {
  it("removes the link and says what it removed", async () => {
    saveProjectLink(dir, createCloudLink(cloudBase))
    expect(await run(["unlink"])).toBe("")
    expect(existsSync(join(dir, LINK_FILE))).toBe(false)
    expect(said.infos.join("\n")).toMatch(/Supatype Cloud project "alpha"/)
    expect(said.infos.join("\n")).toContain(LINK_FILE)
  })

  it("removes the legacy link files too", async () => {
    saveProjectLink(dir, createCloudLink(cloudBase))
    writeFileSync(join(dir, LEGACY_CLOUD_FILE), "{}")
    writeFileSync(join(dir, LEGACY_LINKED_FILE), "{}")
    expect(await run(["unlink"])).toBe("")
    expect(existsSync(join(dir, LEGACY_CLOUD_FILE))).toBe(false)
    expect(existsSync(join(dir, LEGACY_LINKED_FILE))).toBe(false)
    expect(said.infos.join("\n")).toContain(LEGACY_CLOUD_FILE)
  })

  it("says so when there is nothing to remove", async () => {
    expect(await run(["unlink"])).toBe("")
    expect(said.infos.join("\n")).toMatch(/not linked/i)
  })

  it("lets a different project be linked afterwards", async () => {
    saveProjectLink(dir, createCloudLink(cloudBase))
    await run(["unlink"])
    expect(await run(["link", "--project", "beta", "--token", "tok"])).toBe("")
    expect(loadProjectLink(dir)?.projectRef).toBe("beta")
  })
})
