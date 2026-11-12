import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerGenerate } from "../src/commands/generate.js"
import { NEXT_RUNTIME_ENV_ROUTE, upgradeNextRuntimeEnvRoute } from "../src/init-next-runtime-env.js"

/**
 * 0.9.1 release test (RB6): the route init 0.9.1 wrote exports `dynamic = "force-dynamic"`, which
 * Next 16 with cacheComponents (create-next-app's default) answers with a 500. init skips a route
 * that exists, so `supatype generate`, which every install runs through `prepare`, replaces the one
 * init wrote with the current one, and warns about a route that was changed since, without touching it.
 */
const ROUTE_0_9_1 = [
  "// The deployment's API address and anon key for the browser client, read from SUPATYPE_URL and",
  "// SUPATYPE_ANON_KEY on the server at each page load. The root layout loads it before the app.",
  'export { GET } from "@supatype/ssr/next"',
  "// Written here rather than re-exported: Next reads a route's segment config from this file only.",
  'export const dynamic = "force-dynamic"',
  "",
].join("\n")

const dirs: string[] = []
let printed: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project holding `files`; returns its folder and a reader. */
function project(files: Record<string, string>): { dir: string; read: (rel: string) => string | undefined } {
  const dir = mkdtempSync(join(tmpdir(), "supatype-next-route-"))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content, "utf8")
  }
  printed = []
  const record = (...args: unknown[]): void => { printed.push(args.map(String).join(" ")) }
  vi.spyOn(console, "log").mockImplementation(record)
  vi.spyOn(console, "warn").mockImplementation(record)
  vi.spyOn(console, "error").mockImplementation(record)
  return { dir, read: (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : undefined) }
}

describe("upgrading the /supatype-env.js route an earlier init wrote", () => {
  it.each([
    "app/supatype-env.js/route.ts",
    "app/supatype-env.js/route.js",
    "src/app/supatype-env.js/route.ts",
    "src/app/supatype-env.js/route.js",
  ])("rewrites %s, as 0.9.1 wrote it, to the current route and says so in one line", (rel) => {
    const { dir, read } = project({ [rel]: ROUTE_0_9_1 })
    upgradeNextRuntimeEnvRoute(dir)

    expect(read(rel)).toBe(NEXT_RUNTIME_ENV_ROUTE)
    expect(printed.filter((line) => line.includes(rel))).toHaveLength(1)
    expect(printed).toHaveLength(1)
  })

  it("keeps the file's CRLF line endings, as a Windows checkout has them", () => {
    const rel = "app/supatype-env.js/route.ts"
    const { dir, read } = project({ [rel]: ROUTE_0_9_1.replace(/\n/g, "\r\n") })
    upgradeNextRuntimeEnvRoute(dir)

    expect(read(rel)).toBe(NEXT_RUNTIME_ENV_ROUTE.replace(/\n/g, "\r\n"))
  })

  it("leaves a changed route with the dynamic line as it is, and warns once naming every such file", () => {
    const own = `${ROUTE_0_9_1}// mine\n`
    const { dir, read } = project({ "app/supatype-env.js/route.ts": own, "src/app/supatype-env.js/route.js": own })
    upgradeNextRuntimeEnvRoute(dir)

    expect(read("app/supatype-env.js/route.ts")).toBe(own)
    expect(read("src/app/supatype-env.js/route.js")).toBe(own)
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("app/supatype-env.js/route.ts")
    expect(printed[0]).toContain("src/app/supatype-env.js/route.js")
    expect(printed[0]).toContain("export const dynamic")
    expect(printed[0]).toContain("cacheComponents")
  })

  it.each([
    ["the current route", NEXT_RUNTIME_ENV_ROUTE],
    ["a route of the project's own with no dynamic line", 'export { GET } from "@supatype/ssr/next"\n// mine\n'],
  ])("leaves %s alone and prints nothing", (_label, content) => {
    const { dir, read } = project({ "app/supatype-env.js/route.ts": content })
    upgradeNextRuntimeEnvRoute(dir)

    expect(read("app/supatype-env.js/route.ts")).toBe(content)
    expect(printed).toEqual([])
  })

  it("prints nothing in a project with no route", () => {
    const { dir } = project({ "package.json": "{}" })
    upgradeNextRuntimeEnvRoute(dir)
    expect(printed).toEqual([])
  })
})

/** `@supatype/ssr`'s package.json at `version`, as an install leaves it under `node_modules`. */
function ssrAt(version: string): string {
  return JSON.stringify({ name: "@supatype/ssr", version })
}

const SSR_PKG = "node_modules/@supatype/ssr/package.json"
const ROUTE_TS = "app/supatype-env.js/route.ts"

/**
 * The current route needs `@supatype/ssr` 0.9.2, whose `GET` reads the request: with an older one
 * Next prerenders the route and serves it with no values. The 0.9.1 route is replaced whatever the
 * version, since Next answers it with a 500 either way.
 */
describe("the @supatype/ssr the route needs", () => {
  it("replaces the 0.9.1 route and warns once to upgrade an older @supatype/ssr", () => {
    const { dir, read } = project({ [ROUTE_TS]: ROUTE_0_9_1, [SSR_PKG]: ssrAt("0.9.1") })
    upgradeNextRuntimeEnvRoute(dir)

    expect(read(ROUTE_TS)).toBe(NEXT_RUNTIME_ENV_ROUTE)
    const warnings = printed.filter((line) => line.includes("@supatype/ssr"))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("0.9.1")
    expect(warnings[0]).toContain("0.9.2 or later")
    expect(warnings[0]).toContain("prerender")
  })

  it("warns about an older @supatype/ssr beside the current route", () => {
    const { dir } = project({ [ROUTE_TS]: NEXT_RUNTIME_ENV_ROUTE, [SSR_PKG]: ssrAt("0.8.0") })
    upgradeNextRuntimeEnvRoute(dir)
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("0.9.2 or later")
  })

  it("finds @supatype/ssr hoisted to a workspace's root, as Node does", () => {
    const { dir } = project({ [`web/${ROUTE_TS}`]: NEXT_RUNTIME_ENV_ROUTE, [SSR_PKG]: ssrAt("0.9.1") })
    upgradeNextRuntimeEnvRoute(join(dir, "web"))
    expect(printed).toHaveLength(1)
  })

  it.each(["0.9.2", "0.9.2-rc.1", "1.0.0"])("says nothing of @supatype/ssr %s", (version) => {
    const { dir } = project({ [ROUTE_TS]: NEXT_RUNTIME_ENV_ROUTE, [SSR_PKG]: ssrAt(version) })
    upgradeNextRuntimeEnvRoute(dir)
    expect(printed).toEqual([])
  })

  it("says nothing of an older @supatype/ssr in a project with no route", () => {
    const { dir } = project({ [SSR_PKG]: ssrAt("0.9.1") })
    upgradeNextRuntimeEnvRoute(dir)
    expect(printed).toEqual([])
  })

  it("says nothing of a workspace-linked @supatype/ssr, whose source version is not a release", () => {
    const { dir } = project({ [ROUTE_TS]: NEXT_RUNTIME_ENV_ROUTE, "ssr-src/package.json": ssrAt("0.7.0") })
    mkdirSync(join(dir, "node_modules", "@supatype"), { recursive: true })
    symlinkSync(join(dir, "ssr-src"), join(dir, "node_modules", "@supatype", "ssr"), "junction")
    upgradeNextRuntimeEnvRoute(dir)
    expect(printed).toEqual([])
  })
})

describe("supatype generate", () => {
  it("upgrades the route, even when the schema cannot be loaded", async () => {
    const rel = "app/supatype-env.js/route.ts"
    const { dir, read } = project({ [rel]: ROUTE_0_9_1 })
    vi.spyOn(process, "cwd").mockReturnValue(dir)
    vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${String(code)}`) })
    const root = new Command("supatype").exitOverride()
    registerGenerate(root)

    await expect(root.parseAsync(["generate"], { from: "user" })).rejects.toThrow("exit 1")
    expect(read(rel)).toBe(NEXT_RUNTIME_ENV_ROUTE)
  })
})
