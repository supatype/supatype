/**
 * Guards for what the schema engine answers, whether the binary here printed it or a control plane
 * forwarded it (`{ data: <engine answer> }`).
 *
 * Each accepts what the engine sends (schema-engine's serde types): an `Option` it does not skip
 * arrives as `null`, so those keys take `nullable`. A key the CLI never reads is left unchecked,
 * and one an older engine or server leaves out is `optional`.
 */

import {
  isArrayOf,
  isBoolean,
  isJsonObject,
  isNumber,
  isOneOf,
  isShape,
  isString,
  isUnknown,
  nullable,
  optional,
  type Guard,
} from "@supatype/shared"
import type { DoctorReport } from "./commands/doctor.js"
import type { AdoptOutcome, DiffResult, DoctorItem, Operation, ReconcileAction, RenameCandidate } from "./engine-client.js"
import type { EnginePushResult } from "./engine-push-output.js"
import type { DatabaseStateJson, DbColumnState } from "./pull-utils.js"
import type { AppliedRenameRecord } from "./rename-journal.js"
import type { MigrationListEntry, SchemaRollbackResult, SchemaSourcesManifestSummary } from "./resolve-target.js"

const isStringArray = isArrayOf(isString)

/** Accepts anything: for an endpoint whose answer the caller does not read. */
export const isAnyAnswer: Guard<unknown> = isUnknown

// --- Diff ---

const RISKS = ["safe", "warn", "danger", "cautious", "destructive"] as const

export const isOperation: Guard<Operation> = isShape({
  type: optional(isString),
  kind: optional(isString),
  description: optional(isString),
  risk: optional(isOneOf(RISKS)),
  warning: optional(nullable(isString)),
  sql: optional(isString),
  table: optional(isString),
  column: optional(isString),
  constraint: optional(isString),
  index_name: optional(isString),
  index: optional(isUnknown),
  name: optional(isUnknown),
  fields: optional(isUnknown),
})

const isObjectKey = isShape({ kind: isString, schema: isString, parent: isString, name: isString })

export const isReconcileAction: Guard<ReconcileAction> = isShape({
  action: isString,
  key: isObjectKey,
  inline: optional(isBoolean),
  reason: optional(isString),
  security_relevant: optional(isBoolean),
  recorded_def: optional(isString),
  live_def: optional(isString),
  create_sql: optional(isString),
  drifted: optional(
    isShape({ recorded_def: isString, live_def: isString, live_fp: optional(isString), unchecked: optional(isString) }),
  ),
})

export const isRenameCandidate: Guard<RenameCandidate> = isShape({
  kind: isOneOf(["column", "table"] as const),
  table: isString,
  from: isString,
  to: isString,
})

export const isDiffResult: Guard<DiffResult> = isShape({
  operations: isArrayOf(isOperation),
  reconcile: optional(isArrayOf(isReconcileAction)),
  warnings: optional(isStringArray),
  renameCandidates: optional(isArrayOf(isRenameCandidate)),
})

// --- Push ---

export const isEnginePushResult: Guard<EnginePushResult> = isShape({
  status: optional(isString),
  operations: optional(isNumber),
  admin_refreshed: optional(isBoolean),
  message: optional(isString),
  name: optional(isString),
  warnings: optional(isStringArray),
  cache: optional(isShape({ tables: optional(isStringArray), honoured: optional(isBoolean) })),
})

// --- Doctor and adopt ---

export const isDoctorItem: Guard<DoctorItem> = isShape({
  kind: isString,
  table: isString,
  name: isString,
  fields: isStringArray,
  message: isString,
  recorded: optional(isString),
  live: optional(isString),
})

const isDoctorItems = isArrayOf(isDoctorItem)

export const isDoctorReport: Guard<DoctorReport> = isShape({
  missing: isDoctorItems,
  staleManaged: isDoctorItems,
  unmanagedDrift: isDoctorItems,
  drifted: optional(isDoctorItems),
  conflicting: optional(isDoctorItems),
  released: optional(isDoctorItems),
  claimed: optional(isDoctorItems),
  pending: optional(isDoctorItems),
  rebaselined: optional(isDoctorItems),
  rebaselineRefused: optional(isDoctorItems),
  blocking: optional(isBoolean),
})

export const isAdoptOutcome: Guard<AdoptOutcome> = isShape({
  status: optional(isString),
  adopt: optional(isDoctorItems),
  release: optional(isDoctorItems),
  reclaim: optional(isDoctorItems),
  stampStatements: optional(isStringArray),
  stamped: optional(isNumber),
})

// --- Migration history ---

/** The manifest the CLI wrote at push time, as the engine stored and returns it. */
export const isSchemaSourcesManifestSummary: Guard<SchemaSourcesManifestSummary> = isShape({
  entryPoint: optional(isString),
  fileCount: optional(isNumber),
  compressedBytes: optional(isNumber),
  pushedBy: optional(isString),
  files: optional(isArrayOf(isShape({ path: isString }))),
})

export const isSchemaRollbackResult: Guard<SchemaRollbackResult> = isShape({
  status: isString,
  name: isString,
  message: isString,
  restoredMigrationName: optional(nullable(isString)),
  schemaSourcesManifest: optional(nullable(isSchemaSourcesManifestSummary)),
  schemaSourcesBase64: optional(isString),
})

const isAppliedRename: Guard<AppliedRenameRecord> = isShape({
  kind: isOneOf(["column", "table"] as const),
  table: isString,
  from: isString,
  to: isString,
  declared_by: optional(nullable(isString)),
  declared_at: optional(nullable(isString)),
})

export const isMigrationListEntry: Guard<MigrationListEntry> = isShape({
  id: isNumber,
  name: isString,
  hash: isString,
  appliedAt: isString,
  rolledBack: isBoolean,
  engineVersion: isString,
  status: isString,
  schemaSourcesManifest: optional(nullable(isSchemaSourcesManifestSummary)),
  pushedBy: optional(nullable(isString)),
  pushedVia: optional(nullable(isString)),
  pushedFrom: optional(nullable(isString)),
  pushedByVerified: optional(nullable(isBoolean)),
  renames: optional(nullable(isArrayOf(isAppliedRename))),
})

export const isMigrationList: Guard<MigrationListEntry[]> = isArrayOf(isMigrationListEntry)

/** The binary's `migrations` answer: the list, or an object carrying it. */
export const isMigrationsAnswer: Guard<MigrationListEntry[] | { migrations?: MigrationListEntry[] }> = (
  value: unknown,
): value is MigrationListEntry[] | { migrations?: MigrationListEntry[] } =>
  isMigrationList(value) || isShape({ migrations: optional(isMigrationList) })(value)

// --- Introspection ---

/** A live column, with the precision and scale `adopt` reads for a numeric one. */
export const isDbColumnState: Guard<DbColumnState & { numericPrecision?: number | null; numericScale?: number | null }> =
  isShape({
    name: isString,
    dataType: isString,
    udtName: isString,
    nullable: isBoolean,
    default: optional(nullable(isString)),
    ordinalPosition: optional(isNumber),
    isIdentity: optional(isBoolean),
    identityGeneration: optional(nullable(isString)),
    isGenerated: optional(isBoolean),
    generationExpression: optional(nullable(isString)),
    numericPrecision: optional(nullable(isNumber)),
    numericScale: optional(nullable(isNumber)),
  })

export const isDatabaseStateJson: Guard<DatabaseStateJson> = isShape({
  schema: optional(isString),
  tables: isArrayOf(isShape({ schema: optional(isString), name: isString, columns: isArrayOf(isDbColumnState) })),
  constraints: optional(
    isArrayOf(
      isShape({
        table: isString,
        name: isString,
        constraintType: isString,
        columns: isStringArray,
        foreignSchema: optional(nullable(isString)),
        foreignTable: optional(nullable(isString)),
        foreignColumns: optional(nullable(isStringArray)),
        onDelete: optional(nullable(isString)),
        comment: optional(nullable(isString)),
      }),
    ),
  ),
  indexes: optional(
    isArrayOf(
      isShape({
        table: isString,
        name: isString,
        columns: isStringArray,
        unique: isBoolean,
        method: isString,
        isPrimary: isBoolean,
        comment: optional(nullable(isString)),
      }),
    ),
  ),
})

// --- Generated output ---

/** `/generate` and `/migrate`: the text it made, or a message in its place. */
export const isGenerateAnswer = isShape({ code: optional(isString), message: optional(isString) })
export const isMigrateAnswer = isShape({ sql: optional(isString), message: optional(isString) })

/** True for an object: an answer read key by key afterwards, such as the admin config. */
export const isObjectAnswer: Guard<Record<string, unknown>> = isJsonObject
