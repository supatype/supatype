import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

/**
 * A page Supatype serves loads `/supatype-env.js` before the app's own script.
 *
 * The server answers it with the deployment's address and anon key, and the client reads them when
 * the build carried none, so one build works on every deployment that serves it. The tag belongs
 * only where the committed config serves the app statically: a proxied app is served by its own
 * server, which has no such file.
 */
const SCRIPT_TAG = '<script src="/supatype-env.js"></script>'
const dirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Scaffold a project and return a reader for the files it wrote. */
function scaffolded(opts: Parameters<typeof scaffold>[1]): (rel: string) => string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-env-script-"))
  dirs.push(dir)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  scaffold(dir, opts)
  return (rel) => {
    const file = join(dir, rel)
    if (!existsSync(file)) throw new Error(`init wrote no ${rel}`)
    return readFileSync(file, "utf8")
  }
}

/** Whether the tag is in the page's head, where it runs before any module script the body gets. */
function loadsRuntimeEnvInHead(html: string): boolean {
  const at = html.indexOf(SCRIPT_TAG)
  return at !== -1 && at < html.indexOf("</head>")
}

describe("the runtime env script in init's index.html", () => {
  it("is in a static app's page", () => {
    const read = scaffolded({ ...defaultScaffoldOptions("acme"), app: { mode: "static", staticDir: "./public" } })
    expect(loadsRuntimeEnvInHead(read("public/index.html"))).toBe(true)
  })

  it("is in the page Vite builds a static app from, so the built page keeps it", () => {
    const read = scaffolded({
      ...defaultScaffoldOptions("acme"),
      app: { mode: "static", staticDir: "./dist", viteDevUrl: "http://127.0.0.1:5173" },
    })
    expect(loadsRuntimeEnvInHead(read("index.html"))).toBe(true)
    expect(loadsRuntimeEnvInHead(read("dist/index.html"))).toBe(true)
  })

  it("is in a proxied app whose committed config serves its build statically", () => {
    const read = scaffolded({
      ...defaultScaffoldOptions("acme", "self-host"),
      domain: "api.example.com",
      app: { mode: "proxy", upstream: "http://127.0.0.1:5173", start: "vite", viteDevUrl: "http://127.0.0.1:5173" },
    })
    expect(read("supatype.config.ts")).toContain('mode: "static"')
    expect(loadsRuntimeEnvInHead(read("index.html"))).toBe(true)
    expect(loadsRuntimeEnvInHead(read("dist/index.html"))).toBe(true)
  })

  it("is not in a proxied app, which its own server serves", () => {
    const read = scaffolded({
      ...defaultScaffoldOptions("acme", "later"),
      app: { mode: "proxy", upstream: "http://127.0.0.1:5173", start: "vite", viteDevUrl: "http://127.0.0.1:5173" },
    })
    expect(read("supatype.config.ts")).toContain('mode: "proxy"')
    expect(read("index.html")).not.toContain("supatype-env.js")
  })
})
