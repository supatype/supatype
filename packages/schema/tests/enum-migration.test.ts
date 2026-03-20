/**
 * Integration test — Task 98: Enum migration strategies
 *
 * - Add value → safe risk, correct SQL.
 * - Remove value with rows using it → destructive risk + warning.
 * - Remove unused value → succeeds with type recreation (native) or constraint update (TEXT).
 * - Rename value → cautious risk, correct SQL.
 * - Reorder values → native enum recreates type, TEXT+CHECK returns null (no-op).
 */

import { describe, it, expect } from "vitest"
import {
  addEnumValue,
  removeEnumValue,
  renameEnumValue,
  reorderEnumValues,
} from "../src/enum-migration.js"
import type { EnumChange } from "../src/enum-migration.js"

// ─── Add value ──────────────────────────────────────────────────────────────

describe("Task 98 — addEnumValue", () => {
  it("TEXT+CHECK: produces safe risk and replaces CHECK constraint", () => {
    const result = addEnumValue("orders", "status", ["pending", "active", "complete"], {})

    expect(result.kind).toBe("add_value")
    expect(result.risk).toBe("safe")
    expect(result.sql).toHaveLength(2)
    expect(result.sql[0]).toContain("DROP CONSTRAINT")
    expect(result.sql[1]).toContain("ADD CONSTRAINT")
    expect(result.sql[1]).toContain("'pending', 'active', 'complete'")
  })

  it("native enum: uses ALTER TYPE ADD VALUE", () => {
    const result = addEnumValue("orders", "status", ["pending", "active", "complete"], {
      nativeType: true,
      nativeTypeName: "order_status",
    })

    expect(result.kind).toBe("add_value")
    expect(result.risk).toBe("safe")
    expect(result.sql).toHaveLength(1)
    expect(result.sql[0]).toBe("ALTER TYPE order_status ADD VALUE 'complete'")
  })

  it("includes the new value in the constraint list", () => {
    const result = addEnumValue("users", "role", ["admin", "editor", "viewer"], {})
    expect(result.sql[1]).toContain("'admin', 'editor', 'viewer'")
  })
})

// ─── Remove value ───────────────────────────────────────────────────────────

describe("Task 98 — removeEnumValue", () => {
  it("TEXT+CHECK with rows using the value → destructive risk + warning", () => {
    const result = removeEnumValue(
      "orders", "status", "legacy",
      ["pending", "active"],
      42,
      {},
    )

    expect(result.kind).toBe("remove_value")
    expect(result.risk).toBe("destructive")
    expect(result.warning).toBeDefined()
    expect(result.warning).toContain("42 row(s)")
    expect(result.warning).toContain("legacy")
    expect(result.sql).toHaveLength(2)
    expect(result.sql[1]).toContain("'pending', 'active'")
    expect(result.sql[1]).not.toContain("'legacy'")
  })

  it("TEXT+CHECK with zero rows → safe risk, no warning", () => {
    const result = removeEnumValue(
      "orders", "status", "legacy",
      ["pending", "active"],
      0,
      {},
    )

    expect(result.risk).toBe("safe")
    expect(result.warning).toBeUndefined()
  })

  it("native enum with rows → destructive risk + type recreation", () => {
    const result = removeEnumValue(
      "orders", "status", "legacy",
      ["pending", "active"],
      10,
      { nativeType: true, nativeTypeName: "order_status" },
    )

    expect(result.risk).toBe("destructive")
    expect(result.warning).toContain("10 row(s)")
    expect(result.sql).toHaveLength(4)
    // Creates temp type, alters column, drops old type, renames temp
    expect(result.sql[0]).toContain("CREATE TYPE order_status_new")
    expect(result.sql[1]).toContain("ALTER TABLE")
    expect(result.sql[2]).toContain("DROP TYPE order_status")
    expect(result.sql[3]).toContain("RENAME TO order_status")
  })

  it("native enum with zero rows → cautious risk", () => {
    const result = removeEnumValue(
      "orders", "status", "legacy",
      ["pending", "active"],
      0,
      { nativeType: true, nativeTypeName: "order_status" },
    )

    expect(result.risk).toBe("cautious")
    expect(result.warning).toBeUndefined()
  })

  it("remaining values exclude the removed value in SQL", () => {
    const result = removeEnumValue(
      "tasks", "priority", "low",
      ["medium", "high"],
      0,
      {},
    )

    expect(result.sql[1]).toContain("'medium', 'high'")
    expect(result.sql[1]).not.toContain("'low'")
  })
})

// ─── Rename value ───────────────────────────────────────────────────────────

describe("Task 98 — renameEnumValue", () => {
  it("TEXT+CHECK: cautious risk, updates rows then replaces constraint", () => {
    const result = renameEnumValue(
      "orders", "status", "shipped", "dispatched",
      ["pending", "dispatched", "complete"],
      {},
    )

    expect(result.kind).toBe("rename_value")
    expect(result.risk).toBe("cautious")
    expect(result.sql).toHaveLength(3)
    // First: UPDATE rows
    expect(result.sql[0]).toContain("UPDATE")
    expect(result.sql[0]).toContain("'dispatched'")
    expect(result.sql[0]).toContain("'shipped'")
    // Then: DROP + ADD constraint
    expect(result.sql[1]).toContain("DROP CONSTRAINT")
    expect(result.sql[2]).toContain("ADD CONSTRAINT")
    expect(result.sql[2]).toContain("'dispatched'")
  })

  it("native enum: uses ALTER TYPE RENAME VALUE", () => {
    const result = renameEnumValue(
      "orders", "status", "shipped", "dispatched",
      ["pending", "dispatched", "complete"],
      { nativeType: true, nativeTypeName: "order_status" },
    )

    expect(result.kind).toBe("rename_value")
    expect(result.risk).toBe("cautious")
    expect(result.sql).toHaveLength(1)
    expect(result.sql[0]).toBe("ALTER TYPE order_status RENAME VALUE 'shipped' TO 'dispatched'")
  })
})

// ─── Reorder values ─────────────────────────────────────────────────────────

describe("Task 98 — reorderEnumValues", () => {
  it("TEXT+CHECK: returns null (no-op, order not encoded)", () => {
    const result = reorderEnumValues(
      "orders", "status",
      ["complete", "active", "pending"],
      {},
    )

    expect(result).toBeNull()
  })

  it("native enum: cautious risk, recreates type in new order", () => {
    const result = reorderEnumValues(
      "orders", "status",
      ["complete", "active", "pending"],
      { nativeType: true, nativeTypeName: "order_status" },
    )

    expect(result).not.toBeNull()
    const change = result as EnumChange
    expect(change.kind).toBe("reorder_values")
    expect(change.risk).toBe("cautious")
    expect(change.sql).toHaveLength(4)
    expect(change.sql[0]).toContain("CREATE TYPE order_status_new AS ENUM ('complete', 'active', 'pending')")
    expect(change.sql[2]).toContain("DROP TYPE order_status")
    expect(change.sql[3]).toContain("RENAME TO order_status")
  })
})
