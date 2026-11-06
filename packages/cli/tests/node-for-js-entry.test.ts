import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Issue #28: the npm package runs the compiled binary, where process.execPath is `supatype`, not
 * Node. Every JavaScript entry the CLI spawned with process.execPath (Vite for the app and for a
 * Studio override, a `.js` service override) was parsed as a subcommand, exited with `unknown
 * command`, and was restarted forever while every app route answered 502.
 */
const spawned = vi.hoisted((): { bin: string; args: string[] }[] => [])
vi.mock("../src/process-manager.js", () => ({
  readPid: (): null => null,
  ProcessManager: class {
    constructor(bin: string, args: string[]) {
      spawned.push({ bin, args })
    }
  },
}))

const { resolveViteDirectSpawn } = await import("../src/app/proxy-dev-app.js")
const { startStudioViteDevServer } = await import("../src/studio-dev-server.js")
const { launchFromOverride } = await import("../src/component-launch.js")

const NODE_NAME = process.platform === "win32" ? "node.exe" : "node"
const realArgv1 = process.argv[1]
const realExecPath = process.execPath

let root = ""
let nodeOnPath = ""

/** A directory holding `node_modules/vite/bin/vite.js`, as an installed Vite app has. */
function viteApp(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, "node_modules", "vite", "bin"), { recursive: true })
  writeFileSync(join(dir, "node_modules", "vite", "bin", "vite.js"), "")
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "supatype-node-entry-"))
  const binDir = join(root, "node-bin")
  mkdirSync(binDir)
  nodeOnPath = join(binDir, NODE_NAME)
  writeFileSync(nodeOnPath, "")
  // What the compiled binary reports: argv[1] in Bun's embedded filesystem, execPath the program.
  process.argv[1] = "B:/~BUN/root/supatype.exe"
  process.execPath = join(root, "supatype.exe")
  vi.stubEnv("PATH", binDir)
  spawned.length = 0
})

afterEach(() => {
  process.argv[1] = realArgv1 ?? ""
  process.execPath = realExecPath
  vi.unstubAllEnvs()
})

describe("a JavaScript entry spawned from the compiled binary", () => {
  it("runs the app's vite.js with the node on PATH, not the supatype binary", () => {
    const appDir = viteApp("app")
    const spawn = resolveViteDirectSpawn(appDir, "start", { start: "vite" })
    expect(spawn?.bin).not.toBe(process.execPath)
    expect(spawn?.bin).toBe(nodeOnPath)
  })

  it("runs a Studio override's vite.js with the node on PATH", () => {
    viteApp("studio")
    startStudioViteDevServer({
      cwd: root,
      studioOverride: "studio",
      pidDir: root,
      anonKey: "anon",
      proxyTarget: "http://localhost:1",
      viteSupatypeUrl: "http://localhost:2",
    })
    expect(spawned[0]?.bin).toBe(nodeOnPath)
  })

  it("runs a .js service override with the node on PATH", () => {
    writeFileSync(join(root, "realtime.js"), "")
    expect(launchFromOverride("realtime", "realtime.js", root).bin).toBe(nodeOnPath)
  })

  it("refuses with a message naming Node when there is no node on PATH", () => {
    vi.stubEnv("PATH", join(root, "empty"))
    const appDir = viteApp("app")
    expect(() => resolveViteDirectSpawn(appDir, "start", { start: "vite" })).toThrow(/Node\.js/)
  })
})
