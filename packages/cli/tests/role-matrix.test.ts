import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { STUDIO_ROLES } from "../src/commands/admin.js"
import { draftVisibilityRoles, type SupatypeProjectConfig } from "../src/project-config.js"

/**
 * The shared role document. supatype-server embeds the same file and the control plane carries it,
 * and each pins this hash, so what a role may do changes in all three hosts or fails in one.
 */
const ROLE_MATRIX_SHA256 = "db2e046d93ac5142cbf5a1920d9715f5f4537ddce8394059dffeceeb4e2ead0b"

const raw = readFileSync(new URL("../src/role-matrix.json", import.meta.url), "utf8")
const document = JSON.parse(raw) as { selfHostRoles: string[] }

describe("the shared role matrix", () => {
  it("is the document the other hosts carry", () => {
    expect(createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex")).toBe(ROLE_MATRIX_SHA256)
  })

  // A role only this side knows about creates a user who is locked out of the panel they were made
  // for, so the CLI grants exactly the roles a self-hosted server understands.
  it("is the set of roles `supatype admin` grants", () => {
    expect([...STUDIO_ROLES]).toEqual(document.selfHostRoles)
    expect([...STUDIO_ROLES]).toEqual(["admin", "developer", "editor", "viewer"])
  })

  it("lets a project name the viewer among the roles that see drafts", () => {
    const cfg = { publishing: { draft_visibility: ["viewer", "owner"] } } as unknown as SupatypeProjectConfig
    expect(draftVisibilityRoles(cfg)).toEqual(["viewer"])
  })
})
