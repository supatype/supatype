/**
 * Enum migration strategy helpers (Gap Appendices tasks 175-178).
 *
 * Documents and implements the SQL generation strategies for enum changes.
 * These are used by the engine's differ to generate safe migration SQL.
 *
 * For TEXT + CHECK enums (default):
 *   - Add value: ALTER CHECK constraint (safe)
 *   - Remove value: ALTER CHECK constraint (destructive if rows use it)
 *   - Rename value: UPDATE rows + ALTER CHECK (cautious)
 *   - Reorder: No-op (CHECK constraints don't encode order)
 *
 * For native Postgres enums (nativeType: true):
 *   - Add value: ALTER TYPE ADD VALUE (safe, Postgres 12+)
 *   - Remove value: Recreate type (destructive)
 *   - Rename value: ALTER TYPE RENAME VALUE (cautious, Postgres 10+)
 *   - Reorder value: Recreate type (cautious)
 */

export type EnumMigrationRisk = "safe" | "cautious" | "destructive"

export interface EnumChange {
  kind: "add_value" | "remove_value" | "rename_value" | "reorder_values"
  risk: EnumMigrationRisk
  sql: string[]
  description: string
  /** Warning message for the developer (shown during diff/push). */
  warning?: string | undefined
}

/**
 * Generate migration SQL for adding a value to an enum.
 *
 * Safe — additive, no data change.
 */
export function addEnumValue(
  tableName: string,
  columnName: string,
  allValues: readonly string[],
  options: { nativeType?: boolean; nativeTypeName?: string },
): EnumChange {
  if (options.nativeType && options.nativeTypeName) {
    return {
      kind: "add_value",
      risk: "safe",
      sql: [`ALTER TYPE ${options.nativeTypeName} ADD VALUE '${allValues[allValues.length - 1]}'`],
      description: `Add value '${allValues[allValues.length - 1]}' to enum type ${options.nativeTypeName}`,
    }
  }

  // TEXT + CHECK: replace the CHECK constraint
  const checkName = `${tableName}_${columnName}_check`
  const valuesList = allValues.map((v) => `'${v}'`).join(", ")
  return {
    kind: "add_value",
    risk: "safe",
    sql: [
      `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${checkName}"`,
      `ALTER TABLE "${tableName}" ADD CONSTRAINT "${checkName}" CHECK ("${columnName}" IN (${valuesList}))`,
    ],
    description: `Add enum value to ${tableName}.${columnName}`,
  }
}

/**
 * Generate migration SQL for removing a value from an enum.
 *
 * Destructive if rows use the value.
 */
export function removeEnumValue(
  tableName: string,
  columnName: string,
  removedValue: string,
  remainingValues: readonly string[],
  rowCount: number,
  options: { nativeType?: boolean; nativeTypeName?: string },
): EnumChange {
  const hasRows = rowCount > 0

  if (options.nativeType && options.nativeTypeName) {
    // Postgres doesn't support ALTER TYPE REMOVE VALUE.
    // Must recreate the type.
    const typeName = options.nativeTypeName
    const tempName = `${typeName}_new`
    const valuesList = remainingValues.map((v) => `'${v}'`).join(", ")

    return {
      kind: "remove_value",
      risk: hasRows ? "destructive" : "cautious",
      sql: [
        `CREATE TYPE ${tempName} AS ENUM (${valuesList})`,
        `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" TYPE ${tempName} USING "${columnName}"::text::${tempName}`,
        `DROP TYPE ${typeName}`,
        `ALTER TYPE ${tempName} RENAME TO ${typeName}`,
      ],
      description: `Remove value '${removedValue}' from enum type ${typeName}`,
      ...(hasRows && {
        warning: `Removing enum value '${removedValue}' from '${typeName}'. ${rowCount} row(s) currently use this value and will need to be updated first.`,
      }),
    }
  }

  // TEXT + CHECK: replace the constraint
  const checkName = `${tableName}_${columnName}_check`
  const valuesList = remainingValues.map((v) => `'${v}'`).join(", ")
  return {
    kind: "remove_value",
    risk: hasRows ? "destructive" : "safe",
    sql: [
      `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${checkName}"`,
      `ALTER TABLE "${tableName}" ADD CONSTRAINT "${checkName}" CHECK ("${columnName}" IN (${valuesList}))`,
    ],
    description: `Remove enum value '${removedValue}' from ${tableName}.${columnName}`,
    ...(hasRows && {
      warning: `Removing enum value '${removedValue}'. ${rowCount} row(s) currently use this value and must be updated first.`,
    }),
  }
}

/**
 * Generate migration SQL for renaming an enum value.
 *
 * Cautious — data-aware, but no data loss.
 */
export function renameEnumValue(
  tableName: string,
  columnName: string,
  oldValue: string,
  newValue: string,
  allValues: readonly string[],
  options: { nativeType?: boolean; nativeTypeName?: string },
): EnumChange {
  if (options.nativeType && options.nativeTypeName) {
    // Postgres 10+ supports ALTER TYPE RENAME VALUE
    return {
      kind: "rename_value",
      risk: "cautious",
      sql: [`ALTER TYPE ${options.nativeTypeName} RENAME VALUE '${oldValue}' TO '${newValue}'`],
      description: `Rename enum value '${oldValue}' to '${newValue}' in type ${options.nativeTypeName}`,
    }
  }

  // TEXT + CHECK: update rows then replace constraint
  const checkName = `${tableName}_${columnName}_check`
  const valuesList = allValues.map((v) => `'${v}'`).join(", ")
  return {
    kind: "rename_value",
    risk: "cautious",
    sql: [
      `UPDATE "${tableName}" SET "${columnName}" = '${newValue}' WHERE "${columnName}" = '${oldValue}'`,
      `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${checkName}"`,
      `ALTER TABLE "${tableName}" ADD CONSTRAINT "${checkName}" CHECK ("${columnName}" IN (${valuesList}))`,
    ],
    description: `Rename enum value '${oldValue}' to '${newValue}' in ${tableName}.${columnName}`,
  }
}

/**
 * Generate migration SQL for reordering enum values.
 *
 * For native enums: Postgres enum ordering affects sort operations,
 * so reordering requires type recreation. Cautious.
 *
 * For TEXT + CHECK: No-op (CHECK constraints don't encode order).
 */
export function reorderEnumValues(
  tableName: string,
  columnName: string,
  newOrder: readonly string[],
  options: { nativeType?: boolean; nativeTypeName?: string },
): EnumChange | null {
  if (!options.nativeType || !options.nativeTypeName) {
    // TEXT + CHECK: order doesn't matter, no migration needed
    return null
  }

  const typeName = options.nativeTypeName
  const tempName = `${typeName}_new`
  const valuesList = newOrder.map((v) => `'${v}'`).join(", ")

  return {
    kind: "reorder_values",
    risk: "cautious",
    sql: [
      `CREATE TYPE ${tempName} AS ENUM (${valuesList})`,
      `ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" TYPE ${tempName} USING "${columnName}"::text::${tempName}`,
      `DROP TYPE ${typeName}`,
      `ALTER TYPE ${tempName} RENAME TO ${typeName}`,
    ],
    description: `Reorder enum values in type ${typeName}`,
  }
}
