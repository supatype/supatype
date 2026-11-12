/**
 * 0.9.2 release test (N-FF8): on Node 18, init gave a new app Vite 8, which needs Node 20.19 or later,
 * and said nothing; `supatype dev` then restarted the app forever on `SyntaxError: The requested
 * module 'node:util' does not provide an export named 'styleText'`. Init now refuses a Vite app on a
 * Node that cannot run the Vite it adds, before writing anything, and names the Node to install, as
 * the CLI's own floor refusal does (bin/node-version.js).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"

const realVersions = Object.getOwnPropertyDescriptor(process, "versions")
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b-init-vite-node-"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (realVersions !== undefined) Object.defineProperty(process, "versions", realVersions)
  rmSync(dir, { recursive: true, force: true })
})

/** Run as Node `node`, as `process.versions` reports it. */
function onNode(node: string): void {
  Object.defineProperty(process, "versions", { value: { ...process.versions, node }, configurable: true })
}

function initViteApp(): void {
  scaffold(dir, { ...defaultScaffoldOptions("b-init-vite"), app: { mode: "static", staticDir: "./dist", viteDevUrl: "http://127.0.0.1:5173" } })
}

describe("init adding Vite", () => {
  it.each(["18.20.8", "20.18.1", "22.11.0"])("refuses on Node %s, naming the Node to install, before writing anything", (node) => {
    onNode(node)
    expect(initViteApp).toThrow(
      `A Vite app needs Node.js 20.19 or later (22.12 or later on Node 22) for Vite 8, which init adds; this is Node.js ${node}.`,
    )
    expect(existsSync(join(dir, "package.json"))).toBe(false)
    expect(existsSync(join(dir, "supatype.config.ts"))).toBe(false)
  })

  it.each(["20.19.0", "22.12.0", "24.1.0"])("goes ahead on Node %s", (node) => {
    onNode(node)
    initViteApp()
    expect(existsSync(join(dir, "vite.config.ts"))).toBe(true)
  })

  it("goes ahead for an app that already lists its own Vite", () => {
    onNode("18.20.8")
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "b-init-own-vite", type: "module", devDependencies: { vite: "^5.4.0" } }))
    initViteApp()
    expect(existsSync(join(dir, "supatype.config.ts"))).toBe(true)
  })

  it("goes ahead for an app without Vite", () => {
    onNode("18.20.8")
    scaffold(dir, defaultScaffoldOptions("b-init-plain"))
    expect(existsSync(join(dir, "supatype.config.ts"))).toBe(true)
  })
})
