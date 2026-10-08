import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const targetSchemaDoctor = vi.hoisted(() => vi.fn())
const requireEngine = vi.hoisted(() => vi.fn(async () => undefined))
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock("../src/config.js", () => ({ loadConfig: () => ({ project: { name: "app" } }), loadSchemaAst: () => ({ models: [] }) }))
vi.mock("../src/project-config.js", () => ({
  schemaPathFromProject: () => "schema",
  hooksPathFromProject: () => "hooks",
  serviceRoleRoutes: () => [],
}))
vi.mock("../src/resolve-target.js", () => ({
  targetSchemaDoctor,
  schemaPgSchema: () => "public",
  schemaCommandTarget: async () => ({ mode: "direct", databaseUrl: "postgres://x" }),
}))
vi.mock("../src/model-hooks.js", () => ({
  hooksReport: () => ({ declared: [], missing: [], validators: [], validatorsMissing: [], validatorMapMissing: false }),
}))
vi.mock("../src/service-role-check.js", () => ({ checkServiceRoleRoutes: () => ({ missing: [] }) }))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: vi.fn(() => false) }))
vi.mock("../src/ui/clack.js", () => ({ p: { confirm: confirmMock, cancel: vi.fn() }, isCancel: () => false, CLACK_CANCEL: Symbol() }))
vi.mock("../src/engine-ownership-gate.js", () => ({ requireEngineForOwnershipFlag: requireEngine }))

import { rebaselinePlan, registerDoctor, type DoctorReport } from "../src/commands/doctor.js"
import type { DoctorItem } from "../src/engine-client.js"
import { isInteractive } from "../src/ui/interactive.js"

const item = (kind: string, name: string): DoctorItem => ({ kind, table: "posts", name, fields: [], message: `${kind} ${name} drifted` })
const CHECK = item("check", "posts_title_bounds")
const POLICY = item("policy", "posts_select")
const PREVIEW: DoctorReport = { missing: [], staleManaged: [], unmanagedDrift: [], drifted: [CHECK, POLICY] }

async function doctor(...args: string[]): Promise<string> {
  const out: string[] = []
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")))
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")))
  const program = new Command().exitOverride()
  registerDoctor(program)
  await program.parseAsync(["node", "supatype", "doctor", ...args])
  return out.join("\n")
}

/** What each doctor request asked the engine for. */
const requests = () =>
  targetSchemaDoctor.mock.calls.map((call) => ({
    rebaseline: call[2].rebaseline === true,
    overwriteDrift: call[2].overwriteDrift === true,
  }))

describe("rebaselinePlan()", () => {
  it("leaves access drift out unless --overwrite-drift was passed", () => {
    expect(rebaselinePlan(PREVIEW, false)).toEqual({ record: [CHECK], kept: [POLICY] })
    expect(rebaselinePlan(PREVIEW, true)).toEqual({ record: [CHECK, POLICY], kept: [] })
  })
})

describe("supatype doctor --rebaseline", () => {
  beforeEach(() => {
    targetSchemaDoctor.mockReset()
    targetSchemaDoctor.mockImplementation(async (_t, _a, opts: { rebaseline?: boolean }) =>
      opts.rebaseline ? { ...PREVIEW, drifted: [POLICY], rebaselined: [CHECK] } : PREVIEW,
    )
    requireEngine.mockClear()
    confirmMock.mockReset()
    vi.mocked(isInteractive).mockReturnValue(false)
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it("shows what it would record and refuses, exit 1, without --yes when it cannot ask", async () => {
    const out = await doctor("--rebaseline")
    expect(out).toContain("Rebaseline will record these as they are now")
    expect(out).toContain("posts.posts_title_bounds")
    expect(out).toContain("doctor --rebaseline needs --yes when not interactive")
    expect(process.exitCode).toBe(1)
    expect(requests()).toEqual([{ rebaseline: false, overwriteDrift: false }])
  })

  it("records nothing when a person declines", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(false)
    const out = await doctor("--rebaseline")
    expect(out).toContain("Rebaseline cancelled")
    expect(process.exitCode).toBeUndefined()
    expect(requests()).toEqual([{ rebaseline: false, overwriteDrift: false }])
  })

  it("rebaselines with --yes, leaving access drift out without --overwrite-drift", async () => {
    const out = await doctor("--rebaseline", "--yes")
    expect(out).toContain("pass --overwrite-drift to record these too")
    expect(out).toContain("posts.posts_select")
    expect(requests()).toEqual([
      { rebaseline: false, overwriteDrift: false },
      { rebaseline: true, overwriteDrift: false },
    ])
    expect(requireEngine).toHaveBeenCalledWith("--rebaseline", expect.anything())
  })

  it("sends --overwrite-drift alongside the rebaseline when passed", async () => {
    await doctor("--rebaseline", "--overwrite-drift", "--yes")
    expect(requests()).toEqual([
      { rebaseline: false, overwriteDrift: false },
      { rebaseline: true, overwriteDrift: true },
    ])
    expect(requireEngine).toHaveBeenCalledWith("--overwrite-drift", expect.anything())
  })

  it("does not ask when there is nothing to rebaseline", async () => {
    targetSchemaDoctor.mockResolvedValue({ missing: [], staleManaged: [], unmanagedDrift: [], drifted: [] })
    const out = await doctor("--rebaseline")
    expect(out).toContain("Nothing to rebaseline")
    expect(process.exitCode).toBeUndefined()
    expect(requests()).toEqual([{ rebaseline: false, overwriteDrift: false }])
  })
})
