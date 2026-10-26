// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import React from "react"
import { StudioAccessCell } from "../src/components/StudioAccessCell.js"
import { readMembers, type StudioMember, type UseStudioMembersReturn } from "../src/hooks/useStudioMembers.js"
import { isolateEachTest, mount } from "./support.js"

/**
 * A developer with database access can change Studio membership without the membership API. The
 * server records every such change and marks the member; the access cell has to say so, or an
 * admin reading the list has no way to tell a grant made in Studio from one made around it.
 */

isolateEachTest()

const ADA = "11111111-1111-1111-1111-111111111111"

function membersWith(member: StudioMember): UseStudioMembersReturn {
  return {
    members: [member],
    roles: [{ role: "admin", permissions: {} }],
    loading: false,
    error: null,
    roleFor: (userId) => (userId === member.userId ? member.role : null),
    setRole: () => Promise.resolve(true),
    revoke: () => Promise.resolve(true),
    refresh: () => undefined,
  }
}

const BASE: StudioMember = {
  userId: ADA,
  email: "ada@example.com",
  role: "admin",
  platformAccount: false,
  changedOutsideStudio: false,
  createdAt: "",
  updatedAt: "",
}

async function cellText(member: StudioMember, canManage: boolean): Promise<string> {
  const view = await mount(
    <StudioAccessCell userId={ADA} members={membersWith(member)} currentUserId={null} canManage={canManage} />,
  )
  return view.container.textContent ?? ""
}

describe("StudioAccessCell", () => {
  it("flags a grant last changed outside Studio, for a viewer and for an admin", async () => {
    const flagged = { ...BASE, changedOutsideStudio: true }
    expect(await cellText(flagged, false)).toContain("changed outside Studio")
    expect(await cellText(flagged, true)).toContain("changed outside Studio")
  })

  it("says nothing about a grant made through Studio", async () => {
    expect(await cellText(BASE, true)).not.toContain("changed outside Studio")
  })
})

describe("readMembers", () => {
  it("reads the server's flag and defaults it to false", () => {
    const rows = readMembers({
      members: [
        { userId: ADA, role: "admin", changedOutsideStudio: true },
        { userId: "22222222-2222-2222-2222-222222222222", role: "editor" },
      ],
    })
    expect(rows.map((r) => r.changedOutsideStudio)).toEqual([true, false])
  })
})
