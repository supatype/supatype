import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const targetSchemaDoctor = vi.hoisted(() => vi.fn())
const requireEngine = vi.hoisted(() => vi.fn(async (_target: unknown, _needs: Array<{ feature: string; flag: string }>) => undefined))
/** Every feature the target was asked for. */
const asked = (): string[] => requireEngine.mock.calls.flatMap((call) => call[1].map((need) => need.feature))
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock("../src/config.js", () => ({ loadConfig: () => ({ project: { name: "app" } }), loadSchemaAst: () => ({ models: [] }) }))
vi.mock("../src/project-config.js", () => ({
  schemaPathFromProject: () => "schema",
  hooksPathFromProject: () => "hooks",
  serviceRoleRoutes: () => [],
}))
vi.mock("../src/resolve-target.js", () => ({
  targetSchemaDoctor,
  requireTargetFeatures: requireEngine,
  schemaPgSchema: () => "public",
  resolveTarget: () => ({ mode: "direct", databaseUrl: "postgres://x" }),
}))
vi.mock("../src/link.js", () => ({ loadProjectLink: () => null }))
vi.mock("../src/dev-compose.js", () => ({ resolveHostEngineDatabaseUrl: async () => "postgres://x" }))
vi.mock("../src/model-hooks.js", () => ({
  hooksReport: () => ({ declared: [], missing: [], validators: [], validatorsMissing: [], validatorMapMissing: false }),
}))
vi.mock("../src/service-role-check.js", () => ({ checkServiceRoleRoutes: () => ({ missing: [] }) }))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: vi.fn(() => false) }))
vi.mock("../src/ui/clack.js", () => ({ p: { confirm: confirmMock, cancel: vi.fn() }, isCancel: () => false, CLACK_CANCEL: Symbol() }))

import { rebaselinePlan, registerDoctor, type DoctorItem, type DoctorReport } from "../src/commands/doctor.js"
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
    acceptAccessDrift: call[2].acceptAccessDrift === true,
  }))

describe("rebaselinePlan()", () => {
  it("leaves access drift out unless --accept-access-drift was passed", () => {
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
    expect(requests()).toEqual([{ rebaseline: false, acceptAccessDrift: false }])
  })

  it("records nothing when a person declines", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(false)
    const out = await doctor("--rebaseline")
    expect(out).toContain("Rebaseline cancelled")
    expect(process.exitCode).toBeUndefined()
    expect(requests()).toEqual([{ rebaseline: false, acceptAccessDrift: false }])
  })

  it("rebaselines with --yes, leaving access drift out without --accept-access-drift", async () => {
    const out = await doctor("--rebaseline", "--yes")
    expect(out).toContain("pass --accept-access-drift to record these too")
    expect(out).toContain("posts.posts_select")
    expect(requests()).toEqual([
      { rebaseline: false, acceptAccessDrift: false },
      { rebaseline: true, acceptAccessDrift: false },
    ])
    expect(asked()).toContain("rebaseline")
  })

  it("sends --accept-access-drift alongside the rebaseline when passed", async () => {
    await doctor("--rebaseline", "--accept-access-drift", "--yes")
    expect(requests()).toEqual([
      { rebaseline: false, acceptAccessDrift: false },
      { rebaseline: true, acceptAccessDrift: true },
    ])
    expect(asked()).toEqual(["rebaseline", "accept_access_drift"])
  })

  it("refuses --overwrite-drift on doctor, pointing at --accept-access-drift, before anything is read", async () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    let out = ""
    await doctor("--rebaseline", "--overwrite-drift", "--yes").catch((err: Error) => {
      out = vi.mocked(console.error).mock.calls.flat().join(" ")
      expect(err.message).toBe("exit 1")
    })
    expect(out).toContain("supatype doctor --rebaseline --accept-access-drift")
    expect(targetSchemaDoctor).not.toHaveBeenCalled()
  })

  it("refuses --accept-access-drift without --rebaseline", async () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    await expect(doctor("--accept-access-drift")).rejects.toThrow("exit 1")
    expect(targetSchemaDoctor).not.toHaveBeenCalled()
  })

  it("lists what the engine would not rebaseline, as it says", async () => {
    targetSchemaDoctor.mockImplementation(async (_t, _a, opts: { rebaseline?: boolean }) =>
      opts.rebaseline ? { ...PREVIEW, drifted: [POLICY], rebaselined: [CHECK], rebaselineRefused: [POLICY] } : PREVIEW,
    )
    const out = await doctor("--rebaseline", "--yes")
    expect(out).toContain("Not rebaselined (access changed outside Supatype; pass --accept-access-drift to record it) (1)")
    expect(out).toContain("1 not rebaselined")
  })

  it("does not ask when there is nothing to rebaseline", async () => {
    targetSchemaDoctor.mockResolvedValue({ missing: [], staleManaged: [], unmanagedDrift: [], drifted: [] })
    const out = await doctor("--rebaseline")
    expect(out).toContain("Nothing to rebaseline")
    expect(process.exitCode).toBeUndefined()
    expect(requests()).toEqual([{ rebaseline: false, acceptAccessDrift: false }])
  })
  it("says why access drift alone was not recorded, and how it would be", async () => {
    targetSchemaDoctor.mockResolvedValue({ missing: [], staleManaged: [], unmanagedDrift: [], drifted: [POLICY] })
    const out = await doctor("--rebaseline", "--yes")
    expect(out).toContain("pass --accept-access-drift to record these too")
    expect(out).toContain("Nothing to rebaseline")
    expect(requests()).toEqual([{ rebaseline: false, acceptAccessDrift: false }])
  })
})
