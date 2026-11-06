import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

/**
 * Manual test #36: `vite build` warned `<script src="/supatype-env.js"> in "/index.html" can't be
 * bundled without type="module" attribute` on every build of the page init writes. The script is
 * not in the project (the server answers it), so Vite cannot bundle it, and says so. Vite leaves a
 * tag with `vite-ignore` alone. Built with the Vite vitest runs on, the CLI having none of its own;
 * the warning and the attribute are the same in Vite 6, 7 and 8, which init's projects use.
 */
const dirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The part of Vite's API this test calls. */
interface ViteBuildConfig {
  root: string
  configFile: false
  logLevel: "warn"
  customLogger: ViteLogger
  build: { outDir: string; emptyOutDir: boolean }
}
interface ViteLogger {
  info(message: string): void
  warn(message: string): void
  warnOnce(message: string): void
  error(message: string): void
  clearScreen(): void
  hasErrorLogged(): boolean
  hasWarned: boolean
}
interface Vite {
  build(config: ViteBuildConfig): Promise<unknown>
}

function isVite(value: unknown): value is Vite {
  return typeof value === "object" && value !== null && "build" in value && typeof value.build === "function"
}

/** The Vite vitest itself depends on, found through vitest. */
async function loadVite(): Promise<Vite> {
  const vitest = createRequire(import.meta.url).resolve("vitest/package.json")
  const vite: unknown = await import(pathToFileURL(createRequire(vitest).resolve("vite")).href)
  if (!isVite(vite)) throw new Error("vitest's vite has no build()")
  return vite
}

/** Every warning `vite build` gives for `dir`, and the page it built. */
async function viteBuild(dir: string): Promise<{ warnings: string[]; page: string }> {
  const warnings: string[] = []
  const warn = (message: string): void => void warnings.push(message)
  const customLogger: ViteLogger = {
    info: () => undefined,
    warn,
    warnOnce: warn,
    error: warn,
    clearScreen: () => undefined,
    hasErrorLogged: () => false,
    hasWarned: false,
  }
  const outDir = join(dir, "vite-out")
  await (await loadVite()).build({ root: dir, configFile: false, logLevel: "warn", customLogger, build: { outDir, emptyOutDir: true } })
  return { warnings, page: readFileSync(join(outDir, "index.html"), "utf8") }
}

describe("vite build of the page init writes for a Vite app", () => {
  it("gives no warning about the runtime env script, and keeps the script", async () => {
    // The real path: on macOS the temp folder is a symlink (/var to /private/var), and on Windows a
    // runner's may be a short name (RUNNER~1). Vite resolves the page by its real path, so a root
    // that differs from it makes Rollup refuse the page. The native call expands both.
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "supatype-env-vite-")))
    dirs.push(dir)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    scaffold(dir, { ...defaultScaffoldOptions("acme"), app: { mode: "static", staticDir: "./dist", viteDevUrl: "http://127.0.0.1:5173" } })

    const { warnings, page } = await viteBuild(dir)

    expect(warnings.filter((warning) => warning.includes("supatype-env.js"))).toEqual([])
    expect(page).toMatch(/<script src="\/supatype-env\.js"\s*><\/script>/)
    expect(page.indexOf("supatype-env.js")).toBeLessThan(page.indexOf("</head>"))
  }, 60_000)
})
