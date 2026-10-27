import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { afterEach, describe, expect, it } from "vitest"
import { updateAppConfigInProject, updateServerConfigInProject } from "../src/app-config.js"

/**
 * `supatype app add --upstream ...` rewrote init's `app: { mode: "none", }` as
 * `mode: "proxy",,` then `      upstream: ...` then `},`: a syntax error, and indentation that
 * matched nothing around it. The writer keeps the file's own layout and stays valid TypeScript.
 */

const INIT_CONFIG = `import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "app-test" },
  server: {
    mode: "dev",
    port: 54321,
  },
  app: {
    mode: "none",
  },
  email: { provider: "console" },
})
`

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-app-config-"))
  dirs.push(dir)
  writeFileSync(join(dir, "supatype.config.ts"), config, "utf8")
  return dir
}

function configOf(dir: string): string {
  const text = readFileSync(join(dir, "supatype.config.ts"), "utf8")
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } })
  expect(out.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) ?? []).toEqual([])
  return text
}

describe("the app config writer", () => {
  it("writes a proxy upstream into init's app block, indented like it", () => {
    const dir = project(INIT_CONFIG)
    updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:5173" })
    expect(configOf(dir)).toContain(
      '  app: {\n    mode: "proxy",\n    upstream: "http://localhost:5173",\n  },\n  email:',
    )
  })

  it("switches proxy to static and back to none, keeping the file valid", () => {
    const dir = project(INIT_CONFIG)
    updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:5173" })
    updateAppConfigInProject(dir, { mode: "static", staticDir: "./public" })
    expect(configOf(dir)).toContain('  app: {\n    mode: "static",\n    static_dir: "./public",\n  },\n')
    updateAppConfigInProject(dir, { mode: "none" })
    expect(configOf(dir)).toContain('  app: {\n    mode: "none",\n  },\n')
  })

  it("keeps keys of the app block it does not manage", () => {
    const dir = project(INIT_CONFIG.replace('    mode: "none",\n', '    mode: "none",\n    vite: { port: 5173 },\n'))
    updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:3000" })
    expect(configOf(dir)).toContain(
      '  app: {\n    mode: "proxy",\n    vite: { port: 5173 },\n    upstream: "http://localhost:3000",\n  },\n',
    )
  })

  it("adds an app block to a config without one", () => {
    const dir = project(INIT_CONFIG.replace('  app: {\n    mode: "none",\n  },\n', ""))
    updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:3000" })
    expect(configOf(dir)).toContain('  app: {\n    mode: "proxy",\n    upstream: "http://localhost:3000",\n  },\n')
  })

  it("writes the server's domain and tls the same way", () => {
    const dir = project(INIT_CONFIG)
    updateServerConfigInProject(dir, { domain: "example.com", tlsEmail: "ops@example.com" })
    expect(configOf(dir)).toContain(
      '  server: {\n    mode: "standalone",\n    port: 54321,\n    domain: "example.com",\n' +
        '    tls: { email: "ops@example.com", provider: "kong" },\n  },\n',
    )
  })
})

describe("the app config writer on a config init wrote", () => {
  it("leaves it valid TypeScript with one comma per entry", async () => {
    const { defaultScaffoldOptions, scaffold } = await import("../src/commands/init.js")
    const dir = mkdtempSync(join(tmpdir(), "supatype-app-config-init-"))
    dirs.push(dir)
    scaffold(dir, defaultScaffoldOptions("app-test"))
    updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:5173" })
    const text = configOf(dir)
    expect(text).not.toContain(",,")
    expect(text).toContain('  app: {\n    mode: "proxy",\n    upstream: "http://localhost:5173",\n  },\n')
  })
})

describe("the app config writer and comments", () => {
  it("keeps a comment above a key it does not own", () => {
    const dir = project(INIT_CONFIG.replace('    mode: "none",\n', '    mode: "none",\n    // the docs site\n    vite: { port: 5173 },\n'))
    updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:3000" })
    expect(configOf(dir)).toContain('    mode: "proxy",\n    // the docs site\n    vite: { port: 5173 },\n')
  })
})

// Appending a block after the root's last entry has to find the comma that separates it, not one
// inside a comment beside it: taking `// a, b`'s comma left the config unparseable.
describe("the app config writer after a trailing comment", () => {
  const NO_APP = INIT_CONFIG.replace('  app: {\n    mode: "none",\n  },\n', "")
  const APP = '  app: {\n    mode: "proxy",\n    upstream: "http://localhost:3000",\n  },\n'

  function appendedAfter(lastEntry: string): string {
    const dir = project(NO_APP.replace('  email: { provider: "console" },\n', `${lastEntry}\n`))
    updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:3000" })
    return configOf(dir)
  }

  it.each([
    ["a line comment with a comma, no separator", '  email: { provider: "console" } // console, for now'],
    ["a line comment with a comma, after the separator", '  email: { provider: "console" }, // console, for now'],
    ["a block comment with a comma before the separator", '  email: { provider: "console" } /* console, for now */,'],
    ["a block comment with a comma, no separator", '  email: { provider: "console" } /* console, for now */'],
  ])("puts the block after the last entry and %s", (_label, lastEntry) => {
    const text = appendedAfter(lastEntry)
    expect(text).toContain("console, for now")
    expect(text).toContain(`\n${APP}})`)
  })

  it("keeps the comment on the entry it was written beside", () => {
    const text = appendedAfter('  email: { provider: "console" } // console, for now')
    expect(text).toContain('  email: { provider: "console" }, // console, for now\n' + APP)
  })
})
