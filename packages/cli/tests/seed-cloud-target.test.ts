import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteSeedRequest } from "@supatype/types"
import { projectConfig } from "./support/project-config.js"

/**
 * `supatype seed` against a linked project (Cloud or a self-hosted server): the CLI collects every
 * file here, then asks the control plane to apply them. Nothing here talks to a database: `fetch`
 * is the control plane, and the local arm's engine is a recorder.
 */
const said = vi.hoisted(() => ({ errors: [] as string[], infos: [] as string[], successes: [] as string[] }))
const local = vi.hoisted(() => ({ requests: [] as Array<Record<string, unknown>> }))
const terminal = vi.hoisted(() => ({ interactive: false, typed: "", asked: [] as string[] }))

vi.mock("../src/ui/messages.js", () => ({
  error: (m: string) => said.errors.push(m),
  info: (m: string) => said.infos.push(m),
  warn: (m: string) => said.infos.push(m),
  success: (m: string) => said.successes.push(m),
}))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => terminal.interactive }))
vi.mock("../src/ui/prompts.js", () => ({
  promptText: async (message: string) => {
    terminal.asked.push(message)
    return terminal.typed
  },
}))
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig: () => projectConfig(),
  loadSchemaAst: () => ({ models: [] }),
}))
vi.mock("../src/stack-engine.js", () => ({
  stackEngine: async () => undefined,
  engineRequestIn: async (_engine: unknown, _path: string, body: Record<string, unknown>) => {
    local.requests.push(body)
    return { ok: true, files: [] }
  },
}))
vi.mock("../src/local-stack-guard.js", () => ({ requireLocalStack: () => undefined }))
vi.mock("../src/host-database.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/host-database.js")>()),
  resolveHostDatabaseUrl: () => ({ dsn: "postgresql://u:p@127.0.0.1:5432/app" }),
}))

import { runSeed, type SeedFlags } from "../src/commands/seed.js"
import { LINK_VERSION, saveProjectLink, type ProjectLink } from "../src/link.js"
import { forgetServerCapabilities } from "../src/resolve-target.js"

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

interface Reply {
  status: number
  body: unknown
}

let dir: string
let calls: Call[]
let answer: (call: Call) => Reply

const ENGINE_VERSION = "0.11.0"

/** The ref Cloud keeps for the project the link calls `abc` (the link holds the slug). */
const CLOUD_REF = "prj_9f2c41"

function capabilities(features: string[], version = ENGINE_VERSION): Reply {
  return { status: 200, body: { features, version } }
}

function defaultAnswer(call: Call): Reply {
  if (call.method === "GET" && call.url.endsWith("/projects/abc")) {
    return { status: 200, body: { data: { slug: "abc", ref: CLOUD_REF } } }
  }
  if (call.url.endsWith("/schema/capabilities")) return capabilities(["seed"])
  if (call.url.endsWith("/seed/status")) return { status: 200, body: { data: { files: [] } } }
  return { status: 200, body: { data: { ok: true, files: [{ file: "seeds/a.ts", status: "applied" }] }, run: { id: "r1" } } }
}

function isSeedPost(call: Call): boolean {
  return call.method === "POST" && call.url.endsWith("/seed")
}

function link(kind: ProjectLink["kind"]): ProjectLink {
  const stamp = "2026-11-20T00:00:00Z"
  return {
    version: LINK_VERSION,
    kind,
    projectRef: "abc",
    defaultEnvironment: "staging",
    token: "tok",
    ...(kind === "cloud" ? { cloudApiUrl: "https://cloud.test" } : {}),
    environments: {
      staging: { name: "staging", apiUrl: "https://cloud.test", linkedAt: stamp },
      production: { name: "production", apiUrl: "https://cloud.test", linkedAt: stamp },
    },
  }
}

const DEFAULT_EXPORT = "export default async () => {}\n"

function writeSeeds(files: Record<string, string> = { "a.ts": DEFAULT_EXPORT, "b.ts": DEFAULT_EXPORT }): void {
  mkdirSync(join(dir, "seeds"), { recursive: true })
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, "seeds", name), source)
}

function flags(over: Partial<SeedFlags> = {}): SeedFlags {
  return { force: false, atomic: false, status: false, local: false, confirmProduction: false, ...over }
}

function seedPosts(): Call[] {
  return calls.filter(isSeedPost)
}

function stubControlPlane(): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call: Call = {
      method: String(init.method),
      url,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const reply = answer(call)
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } })
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-seed-cloud-"))
  mkdirSync(join(dir, "supatype", "generated"), { recursive: true })
  writeFileSync(
    join(dir, "supatype", "generated", "seed.ts"),
    `export const schemaFingerprint = "fp-1"\nexport const seedModels = {}\n`,
  )
  vi.spyOn(process, "cwd").mockReturnValue(dir)
  said.errors.length = said.infos.length = said.successes.length = 0
  local.requests.length = 0
  terminal.interactive = false
  terminal.typed = ""
  terminal.asked.length = 0
  calls = []
  answer = defaultAnswer
  forgetServerCapabilities()
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", undefined)
  stubControlPlane()
  writeSeeds()
  saveProjectLink(dir, link("cloud"))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe("seeding a linked project", () => {
  it("posts to the project's seed route in the target environment, with no connection", async () => {
    expect(await runSeed(undefined, flags({ env: "staging" }))).toBe(0)
    const [post] = seedPosts()
    expect(post?.url).toBe("https://cloud.test/api/v1/projects/abc/seed")
    expect(post?.headers["X-Supatype-Environment"]).toBe("staging")
    expect(local.requests).toEqual([])
    expect(said.successes).toEqual(["Seeded 2 file(s) into abc (staging)."])
  })

  it("sends the same document strings, byte for byte, as the local path sends the engine", async () => {
    await runSeed(undefined, flags({ env: "staging" }))
    await runSeed(undefined, flags({ local: true }))
    const sent = seedPosts()[0]?.body as RemoteSeedRequest
    expect(local.requests).toHaveLength(1)
    expect(sent.irDocuments).toEqual(local.requests[0]?.["ir_documents"])
    expect(sent.irDocuments.length).toBe(2)
  })

  it("goes to a self-hosted server's /platform/v1 as well", async () => {
    saveProjectLink(dir, link("self-host"))
    expect(await runSeed(undefined, flags({ env: "staging" }))).toBe(0)
    expect(seedPosts()[0]?.url).toBe("https://cloud.test/platform/v1/projects/abc/seed")
  })

  it("sends the run's settings, and where it came from", async () => {
    await runSeed(undefined, flags({ env: "staging", atomic: true }))
    expect(seedPosts()[0]?.body).toMatchObject({
      atomic: true,
      runOnce: false,
      environment: "staging",
      confirmProduction: false,
      ast: { models: [] },
      pushedFrom: expect.any(String),
    })
  })
})

describe("the production gate", () => {
  it("refuses a non-interactive production seed without the flag, and sends nothing", async () => {
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(2)
    expect(seedPosts()).toEqual([])
    expect(said.errors.join("\n")).toContain("--confirm-production")
  })

  it("sends confirmProduction when the flag is given", async () => {
    expect(await runSeed(undefined, flags({ env: "production", confirmProduction: true }))).toBe(0)
    expect(seedPosts()[0]?.body).toMatchObject({ confirmProduction: true, environment: "production" })
  })

  it("asks for the project ref when interactive, and sends only when it is typed", async () => {
    terminal.interactive = true
    terminal.typed = "nope"
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(2)
    expect(seedPosts()).toEqual([])
    terminal.typed = CLOUD_REF
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(0)
    expect(seedPosts()[0]?.body).toMatchObject({ confirmProduction: true })
  })

  it("names the Cloud ref to type, and takes only the ref", async () => {
    terminal.interactive = true
    terminal.typed = CLOUD_REF
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(0)
    expect(terminal.asked.join("\n")).toContain(CLOUD_REF)
    expect(seedPosts()[0]?.body).toMatchObject({ confirmProduction: true })
  })

  it("does not take the slug when the ref is known", async () => {
    terminal.interactive = true
    terminal.typed = "abc"
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(2)
    expect(seedPosts()).toEqual([])
    expect(said.errors.join("\n")).toContain(CLOUD_REF)
  })

  it("reads the ref from the link, and does not ask Cloud for it", async () => {
    saveProjectLink(dir, { ...link("cloud"), ref: CLOUD_REF })
    terminal.interactive = true
    terminal.typed = CLOUD_REF
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(0)
    expect(calls.filter((c) => c.url.endsWith("/projects/abc"))).toEqual([])
    expect(terminal.asked.join("\n")).toContain(CLOUD_REF)
  })

  it("does not take the slug when the link holds the ref", async () => {
    saveProjectLink(dir, { ...link("cloud"), ref: CLOUD_REF })
    terminal.interactive = true
    terminal.typed = "abc"
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(2)
    expect(seedPosts()).toEqual([])
  })

  it("still refuses a wrong answer when the Cloud ref is known", async () => {
    terminal.interactive = true
    terminal.typed = "prj_other"
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(2)
    expect(seedPosts()).toEqual([])
    expect(said.errors.join("\n")).toContain(CLOUD_REF)
  })

  it("falls back to the slug when Cloud cannot say the ref", async () => {
    terminal.interactive = true
    terminal.typed = "abc"
    answer = (call) =>
      call.method === "GET" && call.url.endsWith("/projects/abc")
        ? { status: 500, body: { error: "boom", message: "down" } }
        : defaultAnswer(call)
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(0)
    expect(terminal.asked.join("\n")).toContain("abc")
  })

  it("asks a self-hosted server for nothing: its link already holds the ref", async () => {
    saveProjectLink(dir, link("self-host"))
    terminal.interactive = true
    terminal.typed = "abc"
    expect(await runSeed(undefined, flags({ env: "production" }))).toBe(0)
    expect(calls.filter((c) => c.url.endsWith("/projects/abc"))).toEqual([])
    expect(terminal.asked.join("\n")).toContain("abc")
  })

  it("needs no flag for staging", async () => {
    expect(await runSeed(undefined, flags({ env: "staging" }))).toBe(0)
    expect(seedPosts()).toHaveLength(1)
  })

  it("refuses --force on a linked target, naming --confirm-production, and sends nothing", async () => {
    expect(await runSeed(undefined, flags({ env: "staging", force: true }))).toBe(2)
    expect(said.errors.join("\n")).toContain("--confirm-production")
    expect(calls).toEqual([])
  })
})

describe("--status", () => {
  it("asks the status route and prints what it answers", async () => {
    const drifted = { file: "seeds/a.ts", appliedAt: "t", status: "applied", durationMs: 4, drifted: true }
    answer = (call) => (call.url.endsWith("/seed/status") ? { status: 200, body: { data: { files: [drifted] } } } : defaultAnswer(call))
    expect(await runSeed(undefined, flags({ env: "staging", status: true }))).toBe(0)
    const status = calls.find((c) => c.url.endsWith("/seed/status"))
    expect(status?.method).toBe("GET")
    expect(status?.headers["X-Supatype-Environment"]).toBe("staging")
    expect(said.infos.join("\n")).toContain("changed since it was applied")
    expect(seedPosts()).toEqual([])
  })

  it("works for a caller who may view but not push, without asking for capabilities", async () => {
    // Capabilities needs `schema.push`; the status route needs only `schema.view`.
    answer = (call) =>
      call.url.includes("/capabilities")
        ? { status: 403, body: { error: "forbidden", message: 'Role "editor" does not have the "schema.push" permission' } }
        : call.url.endsWith("/seed/status")
          ? { status: 200, body: { data: { files: [] } } }
          : defaultAnswer(call)
    expect(await runSeed(undefined, flags({ env: "staging", status: true }))).toBe(0)
    expect(said.errors.join("\n")).not.toContain("schema.push")
  })

  it("names an old server when the status route is missing", async () => {
    answer = (call) =>
      call.url.endsWith("/seed/status") ? { status: 404, body: { error: "not_found", message: "Not found" } } : defaultAnswer(call)
    expect(await runSeed(undefined, flags({ env: "staging", status: true }))).toBe(2)
    expect(said.errors.join("\n")).toMatch(/does not support seed/i)
  })
})

describe("a file with no default export", () => {
  it("is refused before it is imported", async () => {
    const marker = join(dir, "imported.marker").replace(/\\/g, "/")
    writeSeeds({ "a.ts": `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "ran")\n` })
    expect(await runSeed(undefined, flags({ env: "staging" }))).toBe(2)
    expect(existsSync(marker)).toBe(false)
    expect(seedPosts()).toEqual([])
    expect(said.errors.join("\n")).toContain("default")
  })

  it("is refused when the file cannot be read as TypeScript", async () => {
    writeSeeds({ "a.ts": "export default (((\n" })
    expect(await runSeed(undefined, flags({ env: "staging" }))).toBe(2)
    expect(seedPosts()).toEqual([])
  })
})

describe("--environment against the target", () => {
  it("is refused when it names a different environment than the target, before anything is sent", async () => {
    expect(await runSeed(undefined, flags({ env: "production", environment: "staging", confirmProduction: true }))).toBe(2)
    expect(calls).toEqual([])
    expect(said.errors.join("\n")).toMatch(/staging.*production|production.*staging/s)
  })

  it("is accepted when it names the target", async () => {
    expect(await runSeed(undefined, flags({ env: "staging", environment: "staging" }))).toBe(0)
  })
})

describe("a control plane that cannot seed", () => {
  it("is refused with the update message, before anything is sent", async () => {
    answer = (call) => (call.url.endsWith("/schema/capabilities") ? capabilities([]) : defaultAnswer(call))
    expect(await runSeed(undefined, flags({ env: "staging" }))).toBe(2)
    expect(said.errors.join("\n")).toContain("this server does not support seed; update it")
    expect(seedPosts()).toEqual([])
  })

  it("is refused when its engine is older than this CLI supports", async () => {
    answer = (call) => (call.url.endsWith("/schema/capabilities") ? capabilities(["seed"], "0.3.0") : defaultAnswer(call))
    expect(await runSeed(undefined, flags({ env: "staging" }))).toBe(2)
    expect(seedPosts()).toEqual([])
  })
})

describe("answers to exit codes", () => {
  const engine = (body: unknown): Reply => ({ status: 200, body: { data: body, run: { id: "r" } } })
  // The message never repeats the code, so the code on the line comes from the CLI.
  const refuse = (status: number, error: string): Reply => ({ status, body: { error, message: "The server said no." } })
  const cases: Array<[string, Reply, number]> = [
    ["200 applied", engine({ ok: true, files: [] }), 0],
    ["200 a constraint failure", engine({ ok: false, error: { kind: "constraint", message: "dup" } }), 1],
    ["200 a connection failure", engine({ ok: false, error: { kind: "connection", message: "down" } }), 2],
    ["400", refuse(400, "validation_error"), 2],
    ["403", refuse(403, "forbidden"), 2],
    ["404", refuse(404, "not_found"), 2],
    ["409", refuse(409, "seed_busy"), 2],
    ["413", refuse(413, "payload_too_large"), 2],
    ["502", refuse(502, "engine_failed"), 2],
  ]
  for (const [name, reply, code] of cases) {
    it(`${name} is exit ${code}`, async () => {
      answer = (call) => (isSeedPost(call) ? reply : defaultAnswer(call))
      expect(await runSeed(undefined, flags({ env: "staging" }))).toBe(code)
    })
  }

  it("shows the server's message for a refusal", async () => {
    answer = (call) => (isSeedPost(call) ? refuse(409, "seed_busy") : defaultAnswer(call))
    await runSeed(undefined, flags({ env: "staging" }))
    expect(said.errors.join("\n")).toContain("[seed_busy] The server said no.")
  })
})

describe("--local on a linked project", () => {
  it("takes the local path and never asks the control plane", async () => {
    expect(await runSeed(undefined, flags({ local: true }))).toBe(0)
    expect(local.requests).toHaveLength(1)
    expect(calls).toEqual([])
  })

  it("--connection also takes the local path", async () => {
    expect(await runSeed(undefined, flags({ connection: "postgresql://u:p@127.0.0.1:5432/app" }))).toBe(0)
    expect(local.requests).toHaveLength(1)
    expect(calls).toEqual([])
  })
})
