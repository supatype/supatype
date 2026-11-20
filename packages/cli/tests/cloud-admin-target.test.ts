import { describe, expect, it, vi } from "vitest"

const link = vi.hoisted(() => ({ kind: "cloud" as string | null }))
vi.mock("../src/link.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/link.js")>()
  return { ...actual, loadProjectLink: () => (link.kind === null ? null : { kind: link.kind }) }
})
vi.mock("../src/resolve-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/resolve-target.js")>()
  return { ...actual, resolveTarget: () => ({ mode: "cloud", projectRef: "demo" }) }
})

const { cloudAdminTarget } = await import("../src/cloud-admin.js")

/** Which `supatype admin` runs: Cloud's member routes for a Cloud-linked project, the database otherwise. */
describe("cloudAdminTarget", () => {
  it("is the linked Cloud project", () => {
    link.kind = "cloud"
    expect(cloudAdminTarget(process.cwd(), undefined)).toMatchObject({ mode: "cloud", projectRef: "demo" })
  })

  it("is nothing when --connection points the command at a database", () => {
    link.kind = "cloud"
    expect(cloudAdminTarget(process.cwd(), "postgresql://localhost/x")).toBeNull()
  })

  it.each([["self-host"], [null]])("is nothing for a project linked to %s", (kind) => {
    link.kind = kind
    expect(cloudAdminTarget(process.cwd(), undefined)).toBeNull()
  })
})
