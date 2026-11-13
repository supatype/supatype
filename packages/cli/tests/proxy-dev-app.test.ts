import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import {
  portFromUpstream,
  resolveProxyDevScript,
  resolveViteDirectSpawn,
} from "../src/app/proxy-dev-app.js"
import { belongsToApp } from "../src/app/port-holder.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

const base = {
  project: { name: "test" },
  database: { provider: "native" as const },
  server: { mode: "dev" as const },
  versions: { engine: "latest", server: "latest", postgres: "latest", deno: "latest" },
}

describe("resolveProxyDevScript()", () => {
  it("returns null when app.mode is not proxy", () => {
    const config = { ...base, app: { mode: "static" as const } } satisfies SupatypeProjectConfig
    expect(resolveProxyDevScript(config)).toBeNull()
  })

  it("defaults to start when proxy mode and app.start omitted", () => {
    const config = {
      ...base,
      app: { mode: "proxy" as const, upstream: "http://127.0.0.1:4321" },
    } satisfies SupatypeProjectConfig
    expect(resolveProxyDevScript(config)).toBe("start")
  })

  it("uses app.start when set", () => {
    const config = {
      ...base,
      app: { mode: "proxy" as const, upstream: "http://127.0.0.1:4321", start: "dev:site" },
    } satisfies SupatypeProjectConfig
    expect(resolveProxyDevScript(config)).toBe("dev:site")
  })
})

describe("portFromUpstream()", () => {
  it("parses port from upstream URL", () => {
    const config = {
      ...base,
      app: { mode: "proxy" as const, upstream: "http://localhost:5285" },
    } satisfies SupatypeProjectConfig
    expect(portFromUpstream(config)).toBe(5285)
  })

  it("returns null when upstream has no port", () => {
    const config = {
      ...base,
      app: { mode: "proxy" as const, upstream: "http://localhost" },
    } satisfies SupatypeProjectConfig
    expect(portFromUpstream(config)).toBeNull()
  })
})

describe("resolveViteDirectSpawn()", () => {
  it("returns node + vite.js for a plain vite script", () => {
    const appDir = join(tmpdir(), `supatype-vite-spawn-${Date.now()}`)
    const viteJs = join(appDir, "node_modules", "vite", "bin", "vite.js")
    mkdirSync(join(appDir, "node_modules", "vite", "bin"), { recursive: true })
    writeFileSync(viteJs, "")
    const result = resolveViteDirectSpawn(appDir, "dev:vite", { "dev:vite": "vite" })
    expect(result).not.toBeNull()
    expect(result?.bin).toBe(process.execPath)
    expect(result?.args[0]).toBe(viteJs)
    expect(result?.shell).toBe(false)
  })

  it("returns null for non-vite scripts", () => {
    const result = resolveViteDirectSpawn(process.cwd(), "dev", { dev: "next dev" })
    expect(result).toBeNull()
  })
})

/** An app directory with an empty node_modules/vite/bin/vite.js, so the direct spawn is offered. */
function viteAppDir(): { appDir: string; viteJs: string } {
  const appDir = join(tmpdir(), `supatype-vite-args-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const viteJs = join(appDir, "node_modules", "vite", "bin", "vite.js")
  mkdirSync(join(appDir, "node_modules", "vite", "bin"), { recursive: true })
  writeFileSync(viteJs, "")
  return { appDir, viteJs }
}

// 0.9.1 release test (FF21): Vite on Node's default `localhost` listened on [::1] on Windows while
// the proxy dialled 127.0.0.1, so the App URL answered 502, or another project's app on that port.
describe("resolveViteDirectSpawn() binds Vite where the proxy dials", () => {
  it("binds the upstream's IPv4 loopback and port, strictly", () => {
    const { appDir, viteJs } = viteAppDir()
    const result = resolveViteDirectSpawn(appDir, "dev", { dev: "vite" }, "http://127.0.0.1:5173", "darwin")
    expect(result?.args).toEqual([viteJs, "--host", "127.0.0.1", "--port", "5173", "--strictPort"])
  })

  it("binds 127.0.0.1 for a localhost upstream too", () => {
    const { appDir, viteJs } = viteAppDir()
    const result = resolveViteDirectSpawn(appDir, "dev", { dev: "vite" }, "http://localhost:5174", "darwin")
    expect(result?.args).toEqual([viteJs, "--host", "127.0.0.1", "--port", "5174", "--strictPort"])
  })

  it("keeps the script's own arguments and does not repeat a flag it already sets", () => {
    const { appDir, viteJs } = viteAppDir()
    const scripts = { dev: "vite --open --port 3000" }
    const result = resolveViteDirectSpawn(appDir, "dev", scripts, "http://127.0.0.1:5173", "darwin")
    expect(result?.args).toEqual([viteJs, "--open", "--port", "3000", "--host", "127.0.0.1", "--strictPort"])
  })

  it("adds no server flags to a command that is not the dev server", () => {
    const { appDir, viteJs } = viteAppDir()
    const result = resolveViteDirectSpawn(appDir, "dev", { dev: "vite build --watch" }, "http://127.0.0.1:5173", "darwin")
    expect(result?.args).toEqual([viteJs, "build", "--watch"])
  })

  it("leaves a script that needs a shell to the package manager", () => {
    const { appDir } = viteAppDir()
    expect(resolveViteDirectSpawn(appDir, "dev", { dev: "vite && echo done" }, "http://127.0.0.1:5173", "darwin")).toBeNull()
  })

  it("adds no host for an upstream that is not this machine's loopback", () => {
    const { appDir, viteJs } = viteAppDir()
    const result = resolveViteDirectSpawn(appDir, "dev", { dev: "vite" }, "http://192.168.1.20:5173", "darwin")
    expect(result?.args).toEqual([viteJs, "--port", "5173", "--strictPort"])
  })
})

// 0.9.2, reported by a tester on Linux: Docker Engine maps host.docker.internal to the docker0
// bridge, not the loopback, so the gateway could not reach a Vite bound to 127.0.0.1 and the App
// URL answered 502. Docker Desktop forwards that name to the loopback, which is why macOS and
// Windows never showed it.
describe("resolveViteDirectSpawn() on Linux listens where the bridge arrives", () => {
  it("binds every IPv4 interface for a 127.0.0.1 or localhost upstream", () => {
    const { appDir, viteJs } = viteAppDir()
    for (const upstream of ["http://127.0.0.1:5173", "http://localhost:5173"]) {
      const result = resolveViteDirectSpawn(appDir, "dev", { dev: "vite" }, upstream, "linux")
      expect(result?.args).toEqual([viteJs, "--host", "0.0.0.0", "--port", "5173", "--strictPort"])
    }
  })

  it("binds every interface for an IPv6 loopback upstream", () => {
    const { appDir, viteJs } = viteAppDir()
    const result = resolveViteDirectSpawn(appDir, "dev", { dev: "vite" }, "http://[::1]:5173", "linux")
    expect(result?.args).toEqual([viteJs, "--host", "::", "--port", "5173", "--strictPort"])
  })

  it("keeps a host the script already sets", () => {
    const { appDir, viteJs } = viteAppDir()
    const scripts = { dev: "vite --host 127.0.0.1" }
    const result = resolveViteDirectSpawn(appDir, "dev", scripts, "http://127.0.0.1:5173", "linux")
    expect(result?.args).toEqual([viteJs, "--host", "127.0.0.1", "--port", "5173", "--strictPort"])
  })
})

// 0.9.1 release test (FF22): dev ended any program on the app's port, another project's included.
describe("belongsToApp()", () => {
  const app = { dir: String.raw`D:\work\shop`, command: "npm run dev" }

  it("owns a process run from the app's directory, whatever the case or separators", () => {
    const commandLine = "node d:/Work/Shop/node_modules/vite/bin/vite.js --host 127.0.0.1"
    expect(belongsToApp({ commandLine }, app, true)).toBe(true)
  })

  it("does not own one from a sibling directory that only starts the same", () => {
    const commandLine = String.raw`node D:\work\shop2\node_modules\vite\bin\vite.js`
    expect(belongsToApp({ commandLine }, app, true)).toBe(false)
  })

  it("owns the shell around the command dev runs for the app", () => {
    const commandLine = String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c "npm run dev"`
    expect(belongsToApp({ commandLine }, app, true)).toBe(true)
  })

  it("owns a process whose working directory is the app's, off Windows", () => {
    const posixApp = { dir: "/home/me/shop", command: "pnpm run dev" }
    expect(belongsToApp({ commandLine: "node server.js", cwd: "/home/me/shop" }, posixApp, false)).toBe(true)
    expect(belongsToApp({ commandLine: "node server.js", cwd: "/home/me/other" }, posixApp, false)).toBe(false)
  })
})
