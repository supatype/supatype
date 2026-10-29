import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { upsertDevComposeEnv } from "../src/dev-compose.js"
import { readEnvValue } from "../src/env-file.js"
import { ensureFunctionsDenoTypes, functionsContextModuleSource } from "../src/functions-deno-types.js"
import { functionTemplateSource } from "../src/functions-template.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import { validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * `ctx.publicUrl`: the project's public address, beside `ctx.url`.
 *
 * `ctx.url` is the address a function calls the API on, and inside the compose stack that is
 * `http://kong:8000`, a name only the stack's own network resolves. The hello template echoed it,
 * so the first thing a new project showed its author was an address their browser cannot open, and
 * a function building a link for a person (an email, a redirect) had nothing better to use.
 * `ctx.publicUrl` is the gateway address a browser or an app uses, taken from the same setting the
 * server is told its own public address with, and never from a Docker name.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function config(server: SupatypeProjectConfig["server"]): SupatypeProjectConfig {
  return validateProjectConfig(
    {
      project: { name: "acme" },
      server,
      app: { mode: "none" },
      database: { provider: "docker" },
      versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
    },
    "supatype.config.ts",
  )
}

/** One service's environment, as `KEY: value` pairs. */
function serviceEnv(compose: string, service: string): Map<string, string> {
  const lines = compose.split("\n")
  const start = lines.indexOf(`  ${service}:`)
  const env = new Map<string, string>()
  if (start === -1) return env
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[a-z][a-z0-9-]*:$/.test(line) || /^\S/.test(line)) break
    const match = /^ {6}([A-Z_]+):\s*(.*)$/.exec(line)
    if (match?.[1] !== undefined) env.set(match[1], (match[2] ?? "").replace(/^"|"$/g, ""))
  }
  return env
}

/** `${NAME:-fallback}` resolved the way compose does: the fallback when NAME is unset or empty. */
function interpolate(value: string, lookup: (name: string) => string): string {
  const pattern = /\$\{([A-Z0-9_]+):-([^${}]*)\}/g
  // Innermost references first, until nothing is left to resolve.
  const once = (text: string): string =>
    text.replace(pattern, (_m: string, name: string, fallback: string) => lookup(name) || fallback)
  let out = value
  for (let next = once(out); next !== out; next = once(out)) out = next
  return out
}

function workerPublicUrl(compose: string): string | undefined {
  return serviceEnv(compose, "functions-worker").get("SUPATYPE_PUBLIC_URL")
}

describe("the functions worker's public URL in compose", () => {
  it("is the dev gateway's localhost address, at the port dev chose", () => {
    const cwd = tempDir("supatype-public-url-dev-")
    writeFileSync(join(cwd, ".env"), "JWT_SECRET=x\n", "utf8")
    const cfg = config({ mode: "dev" })
    upsertDevComposeEnv(cwd, cfg, "anon-key", "service-key", 54399)

    const raw = workerPublicUrl(renderSelfHostCompose(cfg, cwd, { devLocal: true }))
    expect(raw, "the worker has no SUPATYPE_PUBLIC_URL").toBeDefined()
    expect(interpolate(raw ?? "", (name) => readEnvValue(cwd, name, ""))).toBe("http://localhost:54399")
  })

  it("is the address self-host tells the server it has, so the two cannot disagree", () => {
    const compose = renderSelfHostCompose(config({ mode: "standalone" }))
    const server = serviceEnv(compose, "server").get("SUPATYPE_API_EXTERNAL_URL")
    expect(server).toBeDefined()
    expect(workerPublicUrl(compose)).toBe(server)
    expect(interpolate(workerPublicUrl(compose) ?? "", (name) => (name === "API_EXTERNAL_URL" ? "https://api.acme.dev" : "")))
      .toBe("https://api.acme.dev")
  })

  it("defaults to the https domain when self-host serves TLS", () => {
    const tls = config({ mode: "standalone", domain: "api.example.com", tls: { email: "ops@example.com" } })
    expect(interpolate(workerPublicUrl(renderSelfHostCompose(tls)) ?? "", () => "")).toBe("https://api.example.com")
  })

  for (const devLocal of [true, false]) {
    it(`never names a Docker service (${devLocal ? "dev" : "self-host"})`, () => {
      const compose = renderSelfHostCompose(config({ mode: devLocal ? "dev" : "standalone" }), process.cwd(), { devLocal })
      expect(workerPublicUrl(compose)).toBeDefined()
      expect(workerPublicUrl(compose)).not.toMatch(/kong|server:|functions-worker/)
      // ctx.url is unchanged: the in-stack address real functions call the API on.
      expect(serviceEnv(compose, "functions-worker").get("SUPATYPE_URL")).toBe("http://kong:8000")
    })
  }
})

describe("the context type", () => {
  it("declares publicUrl beside url, and says which one is for people", () => {
    const source = functionsContextModuleSource()
    expect(source).toContain("readonly url: string")
    expect(source).toContain("readonly publicUrl: string")
    const doc = source.slice(0, source.indexOf("readonly publicUrl: string"))
    expect(doc.slice(doc.lastIndexOf("/**"))).toMatch(/links you give to people/)
  })
})

const require = createRequire(import.meta.url)

function runTsc(projectDir: string): { status: number | null; output: string } {
  const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc")
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json", "--pretty", "false"], {
    cwd: projectDir,
    encoding: "utf8",
  })
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` }
}

describe("the function template", () => {
  const source = functionTemplateSource("hello")

  it("returns publicUrl and no longer echoes the internal url", () => {
    expect(source).toContain("const { publicUrl } = ctx")
    expect(source).toMatch(/JSON\.stringify\(\{ message: "Hello from hello!", publicUrl \}\)/)
    expect(source).not.toMatch(/[{,]\s*url\s*[},]/)
    expect(source).not.toContain("ctx.url")
  })

  it("typechecks against the generated context type", () => {
    const root = tempDir("supatype-public-url-tsc-")
    const functionsDir = join(root, "functions")
    mkdirSync(join(functionsDir, "hello"), { recursive: true })
    writeFileSync(join(functionsDir, "hello", "index.ts"), source, "utf8")
    ensureFunctionsDenoTypes(root, functionsDir)
    expect(readFileSync(join(functionsDir, "_shared", "context.ts"), "utf8")).toContain("publicUrl")

    const { status, output } = runTsc(functionsDir)
    expect(status, `tsc failed:\n${output}`).toBe(0)
  })
})
