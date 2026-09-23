import { describe, expect, it } from "vitest"
import {
  affordanceColumn,
  cellAccess,
  isFieldCreatable,
  isFieldRestricted,
  isFieldWritable,
  isOperationOffered,
  needsPerRecordCheck,
  normaliseFieldAccess,
  normaliseTableAccess,
  type StudioFieldAccess,
} from "../src/hooks/useStudioFieldAccess.js"
import { applyFieldAccess } from "../src/lib/field-access-layout.js"
import type { FieldConfig } from "../src/config.js"

// Studio renders from advisory answers: the database is what refuses. So every rule here fails
// open, and: the point that reshaped this module, the interface must never hide a value that
// actually came back. An administrator acts elevated by default, which the masking extension
// exempts, so restricted columns reach them in full; blanking those would hide data they are
// entitled to and misrepresent a restriction that is not being applied to them.

const access = (
  fields: StudioFieldAccess["fields"],
  extra: Partial<StudioFieldAccess> = {},
): StudioFieldAccess => ({ resolved: true, mode: "self", fields, tables: {}, ...extra })

const UNRESOLVED: StudioFieldAccess = {
  resolved: false,
  mode: "self",
  fields: {},
  tables: {},
}

const field = (name: string, extra: Partial<FieldConfig> = {}): FieldConfig =>
  ({ name, label: name, widget: "text", ...extra }) as FieldConfig

const RESTRICTED = { posts: { secret: { read: "deny", write: "deny", create: "deny" } } } as const

describe("normaliseFieldAccess", () => {
  it("reads the server's shape", () => {
    expect(normaliseFieldAccess(RESTRICTED)).toEqual(RESTRICTED)
  })

  // An unrecognised verdict must not invent a restriction, it behaves as unrestricted, which is
  // the same as not having asked.
  it("treats an unknown verdict as unrestricted", () => {
    const result = normaliseFieldAccess({
      posts: { salary: { read: "someFutureVerdict", write: "row", create: "deny" } },
    })
    expect(result["posts"]?.["salary"]).toEqual({ read: "allow", write: "row", create: "deny" })
  })

  it.each([[null], [undefined], ["nonsense"], [42]])("survives junk: %s", (input) => {
    expect(normaliseFieldAccess(input)).toEqual({})
  })

  it("drops tables with no usable columns", () => {
    expect(normaliseFieldAccess({ posts: { salary: null } })).toEqual({})
  })
})

describe("normaliseTableAccess", () => {
  it("reads the P2.6 access section", () => {
    expect(normaliseTableAccess({ posts: { read: "allow", delete: "deny", update: "row" } })).toEqual(
      { posts: { read: "allow", delete: "deny", update: "row" } },
    )
  })

  it.each([[null], ["nonsense"]])("survives junk: %s", (input) => {
    expect(normaliseTableAccess(input)).toEqual({})
  })
})

describe("cellAccess", () => {
  const resolved = access(RESTRICTED)

  it("leaves an unrestricted column alone", () => {
    expect(cellAccess(resolved, "posts", "title", "hello")).toBe("plain")
    expect(cellAccess(resolved, "posts", "title", null)).toBe("plain")
    expect(cellAccess(resolved, "other", "secret", null)).toBe("plain")
  })

  // A withheld column arrives as null, which as an empty cell is indistinguishable from a record
  // that simply has no value. Only claimable when masking is applied and the verdict is settled.
  it("marks a withheld value as hidden", () => {
    expect(cellAccess(resolved, "posts", "secret", null)).toBe("hidden")
    expect(cellAccess(resolved, "posts", "secret", undefined)).toBe("hidden")
  })

  // The case that reshaped this: an elevated caller receives the real value. Rendering a lock
  // there would hide data they are entitled to.
  it("marks a restricted value that came back as revealed, never hidden", () => {
    expect(cellAccess(resolved, "posts", "secret", 100)).toBe("revealed")
    expect(cellAccess(access(RESTRICTED, { mode: "elevated" }), "posts", "secret", 100)).toBe(
      "revealed",
    )
  })

  // An empty restricted column is not evidence of hiding. Masking is not applied to an elevated
  // caller at all, so a null is genuinely a null, a record created without a value for the
  // column must not come back looking like a record withholding one.
  it("does not lock an empty cell for an elevated caller", () => {
    const elevated = access(RESTRICTED, { mode: "elevated" })
    expect(cellAccess(elevated, "posts", "secret", null)).toBe("revealed")
    expect(cellAccess(elevated, "posts", "secret", undefined)).toBe("revealed")
    expect(cellAccess(elevated, "posts", "secret", "")).toBe("revealed")
  })

  // Under a per-row rule a null is genuinely ambiguous: some records withhold, others are empty.
  // Saying so beats guessing either way.
  it("admits it cannot tell for a per-row rule with no value", () => {
    const rowDependent = access({ posts: { secret: { read: "row", write: "row", create: "row" } } })
    expect(cellAccess(rowDependent, "posts", "secret", null)).toBe("unknown")
    expect(cellAccess(rowDependent, "posts", "secret", "visible")).toBe("revealed")
  })

  // A falsy value that is not null is still a value, so it must never be read as withheld.
  it.each([[0], [false], [""]])("treats the falsy value %s as present", (value) => {
    expect(cellAccess(resolved, "posts", "secret", value)).toBe("revealed")
  })

  it("claims nothing before the answer arrives", () => {
    expect(cellAccess(UNRESOLVED, "posts", "secret", null)).toBe("plain")
    expect(isFieldRestricted(UNRESOLVED, "posts", "secret")).toBe(false)
  })
})

describe("write and create predicates", () => {
  it("blocks a settled deny in self mode", () => {
    const resolved = access(RESTRICTED)
    expect(isFieldWritable(resolved, "posts", "secret")).toBe(false)
    expect(isFieldCreatable(resolved, "posts", "secret")).toBe(false)
  })

  // Elevated requests run as the service role, which the extension exempts, so the write will
  // succeed and disabling the input would be a lie about a restriction that is not applied.
  it("allows everything when elevated", () => {
    const elevated = access(RESTRICTED, { mode: "elevated" })
    expect(isFieldWritable(elevated, "posts", "secret")).toBe(true)
    expect(isFieldCreatable(elevated, "posts", "secret")).toBe(true)
  })

  it("allows everything before the answer arrives", () => {
    expect(isFieldWritable(UNRESOLVED, "posts", "secret")).toBe(true)
    expect(isFieldCreatable(UNRESOLVED, "posts", "secret")).toBe(true)
  })

  // `row` is not settled, so the user is let through and the database decides.
  it("lets a row-dependent write through", () => {
    const rowDependent = access({ posts: { secret: { read: "row", write: "row", create: "deny" } } })
    expect(isFieldWritable(rowDependent, "posts", "secret")).toBe(true)
  })
})

describe("isOperationOffered", () => {
  const tables = { posts: { read: "allow", create: "deny", update: "row", delete: "deny" } }
  const resolved = access({}, { tables })

  it("withdraws a control the caller certainly cannot use", () => {
    expect(isOperationOffered(resolved, "posts", "create")).toBe(false)
    expect(isOperationOffered(resolved, "posts", "delete")).toBe(false)
  })

  // `row` keeps the control: some records allow it, and withdrawing it wholesale would hide an
  // action the caller does have on most of their rows.
  it("keeps a control whose answer depends on the record", () => {
    expect(isOperationOffered(resolved, "posts", "update")).toBe(true)
  })

  it("keeps everything when elevated or unresolved", () => {
    expect(isOperationOffered(access({}, { tables, mode: "elevated" }), "posts", "delete")).toBe(true)
    expect(isOperationOffered(UNRESOLVED, "posts", "delete")).toBe(true)
  })

  it("keeps everything for a table the schema does not describe", () => {
    expect(isOperationOffered(resolved, "unknown_table", "delete")).toBe(true)
  })
})

describe("per-record checks", () => {
  const tables = { posts: { delete: "row", update: "deny", create: "allow" } }

  // Asked only where the answer genuinely varies. Requesting the affordance column on a table the
  // engine does not manage would fail the whole query, not just this check.
  it("asks only for a row-dependent verdict", () => {
    const resolved = access({}, { tables })
    expect(needsPerRecordCheck(resolved, "posts", "delete")).toBe(true)
    expect(needsPerRecordCheck(resolved, "posts", "update")).toBe(false)
    expect(needsPerRecordCheck(resolved, "posts", "create")).toBe(false)
    expect(needsPerRecordCheck(resolved, "unknown_table", "delete")).toBe(false)
  })

  it("never asks when elevated or unresolved", () => {
    expect(needsPerRecordCheck(access({}, { tables, mode: "elevated" }), "posts", "delete")).toBe(false)
    expect(needsPerRecordCheck(UNRESOLVED, "posts", "delete")).toBe(false)
  })

  it("names the generated affordance function", () => {
    expect(affordanceColumn("posts", "delete")).toBe("can_delete_posts")
  })
})

describe("applyFieldAccess", () => {
  const fields = [field("title"), field("secret"), field("owner_id")]

  it("disables an unwritable field when editing", () => {
    const result = applyFieldAccess(
      fields,
      access({ posts: { secret: { read: "allow", write: "deny", create: "deny" } } }),
      "posts",
      false,
    )
    expect(result.map((f) => f.name)).toEqual(["title", "secret", "owner_id"])
    expect(result.find((f) => f.name === "secret")?.readOnly).toBe(true)
  })

  // The case `create` exists for: an ownership write rule is satisfiable on update by the owner
  // and satisfiable on insert by nobody.
  it("omits an uncreatable field from a create form", () => {
    const result = applyFieldAccess(
      fields,
      access({ posts: { owner_id: { read: "allow", write: "row", create: "deny" } } }),
      "posts",
      true,
    )
    expect(result.map((f) => f.name)).toEqual(["title", "secret"])
  })

  it("keeps the same field when editing, because the owner can change it", () => {
    const result = applyFieldAccess(
      fields,
      access({ posts: { owner_id: { read: "allow", write: "row", create: "deny" } } }),
      "posts",
      false,
    )
    expect(result.find((f) => f.name === "owner_id")?.readOnly).toBeUndefined()
  })

  // An administrator must not meet a disabled input for a column they can in fact write.
  it("leaves the form untouched when elevated", () => {
    const elevated = access(RESTRICTED, { mode: "elevated" })
    expect(applyFieldAccess(fields, elevated, "posts", false).find((f) => f.name === "secret")?.readOnly)
      .toBeUndefined()
    expect(applyFieldAccess(fields, elevated, "posts", true).map((f) => f.name)).toEqual([
      "title",
      "secret",
      "owner_id",
    ])
  })

  it("returns the list untouched before the answer arrives", () => {
    expect(applyFieldAccess(fields, UNRESOLVED, "posts", true)).toBe(fields)
  })

  it("returns the list untouched for a table with no field rules", () => {
    expect(applyFieldAccess(fields, access({ other: {} }), "posts", true)).toBe(fields)
  })

  it("does not mutate the input", () => {
    const original = [field("secret")]
    applyFieldAccess(
      original,
      access({ posts: { secret: { read: "allow", write: "deny", create: "deny" } } }),
      "posts",
      false,
    )
    expect(original[0]?.readOnly).toBeUndefined()
  })
})
