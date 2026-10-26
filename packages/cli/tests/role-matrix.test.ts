import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { isArrayOf, isShape, isString } from "@supatype/shared"
import { STUDIO_ROLES } from "../src/commands/admin.js"
import { draftVisibilityRoles, validateProjectConfig } from "../src/project-config.js"
import { parseJsonAs } from "./support/json.js"
import { projectConfig } from "./support/project-config.js"

/**
 * The shared role document. supatype-server embeds the same file and the control plane carries it,
 * and each pins this hash, so what a role may do changes in all three hosts or fails in one.
 */
const ROLE_MATRIX_SHA256 = "db2e046d93ac5142cbf5a1920d9715f5f4537ddce8394059dffeceeb4e2ead0b"

const raw = readFileSync(new URL("../src/role-matrix.json", import.meta.url), "utf8")
const document = parseJsonAs(raw, isShape({ selfHostRoles: isArrayOf(isString) }))

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
    // "owner" is no Studio role, so it can only arrive as a config file's text, through the loader.
    const fromFile = { ...projectConfig(), publishing: { draft_visibility: ["viewer", "owner"] } }
    const cfg = validateProjectConfig(fromFile, "supatype.config.ts")
    expect(draftVisibilityRoles(cfg)).toEqual(["viewer"])
  })
})
