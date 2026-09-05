/**
 * Which models keep drafts and version history, read from the extracted schema.
 *
 * The answer shapes things decided before any database exists: whether `PGRST_DB_SCHEMA` names the
 * generated `draft` schema, and whether the push refuses a model that also masks a column. So it is
 * read from the AST rather than asked of Postgres, the same way
 * [`field-masking-tier`](./field-masking-tier.ts) decides the masking tier offline.
 *
 * Shaped loosely on purpose: the CLI's AST carries `options` as an opaque record, and nothing here
 * needs more than "is `versions` present, and what did it ask for".
 */

import { existsSync } from "node:fs"
import { loadSchemaAst } from "./config.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import type { ExtractedSchemaAstV2 } from "./schema-ast-v2.js"
import { draftVisibilityRoles, previewLimits, schemaPathFromProject } from "./project-config.js"

/** Versions kept per record when the model states no retention. */
export const DEFAULT_VERSIONS_KEPT = 20

/** What a model's `versions` declaration resolves to. */
export type VersionsOptions = {
  /** Editing writes a draft version rather than the live row. */
  drafts: boolean
  /** Versions kept per record, oldest pruned beyond it. */
  keep: number
}

/** One versioned model, as the callers of this module need it. */
export type VersionedModel = {
  /** The model's declared name, for an error message that names what the author wrote. */
  name: string
  /** Its table, which is what `<table>_versions` and `draft.<table>` are named after. */
  tableName: string
  options: VersionsOptions
}

type LooseModel = {
  name?: unknown
  options?: Record<string, unknown>
  annotations?: { db?: { tableName?: unknown }; platform?: { access?: Record<string, unknown> } }
}

/**
 * Normalise a `versions` value from the AST.
 *
 * `true` is shorthand for `{ drafts: true }` with the default retention, and a non-positive or
 * unparseable `keep` falls back to the default rather than to "keep nothing": pruning to zero would
 * delete the draft the author is editing.
 */
export function resolveVersionsOptions(raw: unknown): VersionsOptions | undefined {
  if (raw === true) return { drafts: true, keep: DEFAULT_VERSIONS_KEPT }
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as { drafts?: unknown; keep?: unknown }
  const keep =
    typeof record.keep === "number" && Number.isFinite(record.keep) && record.keep >= 1
      ? Math.floor(record.keep)
      : DEFAULT_VERSIONS_KEPT
  return { drafts: record.drafts !== false, keep }
}

/** Every model in the schema that declares `versions`, in declaration order. */
export function versionedModels(ast: unknown): VersionedModel[] {
  const models = (ast as { models?: unknown[] } | null)?.models
  if (!Array.isArray(models)) return []

  const out: VersionedModel[] = []
  for (const entry of models) {
    const model = entry as LooseModel | null
    if (model === null || typeof model !== "object") continue
    const options = resolveVersionsOptions(model.options?.["versions"])
    if (options === undefined) continue
    const name = typeof model.name === "string" ? model.name : ""
    const tableName = model.annotations?.db?.tableName
    out.push({
      name,
      tableName: typeof tableName === "string" ? tableName : name,
      options,
    })
  }
  return out
}

/** Whether anything in the schema is versioned, which is what exposes the `draft` schema. */
export function schemaHasVersionedModels(ast: unknown): boolean {
  return versionedModels(ast).length > 0
}

/**
 * Models declaring both `versions` and per-column rules, which cannot both be enforced.
 *
 * A version snapshot is opaque `jsonb`. `supatype_mask` is driven by security labels on a specific
 * table's column and rewrites references to *that* column, and the view tier puts the masking
 * expression in a view over the real columns: neither can see inside a snapshot. So a masked value
 * sits in plain sight in the versions table for anyone able to read it, and the push refuses rather
 * than applying a schema whose restrictions have a hole in them.
 *
 * Per model, and that matters: under the view tier the managed schema comes off the exposed list but
 * the API roles keep their privileges on the base tables, so a `security_invoker` view in an exposed
 * schema — which is exactly what `draft.<table>` is — reaches past the `api` layer. A project may
 * hold a masked model and a versioned model at once; one model may not be both.
 */
export function modelsWithVersionsAndFieldRules(ast: unknown): string[] {
  const models = (ast as { models?: unknown[] } | null)?.models
  if (!Array.isArray(models)) return []

  const out: string[] = []
  for (const entry of models) {
    const model = entry as LooseModel | null
    if (model === null || typeof model !== "object") continue
    if (resolveVersionsOptions(model.options?.["versions"]) === undefined) continue
    const fields = model.annotations?.platform?.access?.["fields"]
    if (typeof fields !== "object" || fields === null || Object.keys(fields).length === 0) continue
    out.push(typeof model.name === "string" ? model.name : "(unnamed model)")
  }
  return out
}

/**
 * Whether this project on disk has any versioned model.
 *
 * A schema that fails to load reads as "no versioned models", the narrower answer: deciding the
 * exposed-schema list is the wrong moment to report a syntax error, and `push` and `dev` do it
 * properly moments later with the file and line. Narrower rather than wider on purpose, since the
 * failure mode of guessing wrong here is exposing a schema of drafts.
 */
export function projectHasVersionedModels(cwd: string, config: SupatypeProjectConfig): boolean {
  try {
    const schemaPath = schemaPathFromProject(config, cwd)
    if (!existsSync(schemaPath)) return false
    return schemaHasVersionedModels(loadSchemaAst(schemaPath, cwd))
  } catch {
    return false
  }
}

/**
 * The AST with this project's publishing settings attached, when anything is versioned.
 *
 * The engine compiles draft visibility into the generated policies, and it **refuses** a push whose
 * schema has versioned models and carries no settings rather than applying a default. That refusal
 * is the reason this is safe to add at a handful of call sites instead of somewhere unmissable: a
 * path that forgets fails loudly at push time, naming what is missing, rather than quietly
 * narrowing or widening who can read unpublished content.
 *
 * Returns the AST untouched for a project with no versioned model, so nothing else grows a key it
 * has no use for.
 */
export function withPublishing(
  ast: ExtractedSchemaAstV2,
  config: SupatypeProjectConfig,
): ExtractedSchemaAstV2 {
  if (!schemaHasVersionedModels(ast)) return ast

  const limits = previewLimits(config)
  return {
    ...ast,
    publishing: {
      draftVisibility: draftVisibilityRoles(config),
      previewDefaultTtl: limits.defaultTtl,
      previewMaxRecordTtl: limits.maxRecordTtl,
      previewMaxProjectTtl: limits.maxProjectTtl,
      previewAllowProjectScope: limits.allowProjectScope,
    },
  }
}
