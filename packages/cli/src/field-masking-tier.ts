/**
 * Which mechanism will enforce this project's per-column rules — decided offline.
 *
 * The engine makes the same decision at push time by asking the database whether `supatype_mask` is
 * installed. The CLI has to answer earlier: it writes `PGRST_DB_SCHEMA` when it generates compose,
 * before any database necessarily exists. It can, because the extension needs
 * `shared_preload_libraries` and a compiled library on the host, so exactly one path ships it —
 * `supatype/postgres`. Everything else gets the view tier:
 *
 * | Config                                       | Ships the extension | Tier      |
 * | -------------------------------------------- | ------------------- | --------- |
 * | `database.provider: "docker"`                | yes                 | extension |
 * | `provider: native`                           | no                  | views     |
 * | `database.external`                          | no                  | views     |
 * | `provider: docker` + `database.image` override | no                | views     |
 *
 * Deliberately **not** "is the database external": a native `supatype dev` has no extension either,
 * and treating it as tier 1 would point PostgREST at a schema whose tables the API roles no longer
 * hold privileges on — every request denied.
 *
 * The one case this cannot call is a self-managed Postgres where the operator compiled and installed
 * the extension themselves and points at it with `database.external`. They set `schema.api_schemas`
 * explicitly; `supatype db check` reports the mismatch either way.
 */

import { existsSync } from "node:fs"
// Statically imported: these packages are ESM, where `require` does not exist. The first attempt used
// it for a lazy import and every command that generates compose would have thrown at runtime — caught
// by the tests that run the built binary rather than the source.
import { loadSchemaAst } from "./config.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import {
  resolveRuntimeProvider,
  schemaPathFromProject,
  usesExternalDatabase,
} from "./project-config.js"

export type FieldMaskingTier = "none" | "extension" | "views"

/** Postgres image this project would run, when it runs one at all. */
function postgresImage(config: SupatypeProjectConfig): string | undefined {
  if (usesExternalDatabase(config)) return undefined
  if (config.database.provider !== "docker" && resolveRuntimeProvider(config) !== "docker") {
    return undefined
  }
  return config.database.image?.trim() || "supatype/postgres:latest"
}

/** True when the Postgres this project runs is one that carries `supatype_mask`. */
export function imageShipsMaskExtension(config: SupatypeProjectConfig): boolean {
  const image = postgresImage(config)
  return image !== undefined && /^supatype\/postgres(:|$)/.test(image)
}

/**
 * Whether any model masks a column.
 *
 * Read from the extracted AST rather than the config, because that is where field rules live. Shaped
 * loosely on purpose: the CLI's AST type carries `platform.access` as an opaque record, and this only
 * needs to know whether a `fields` map is present and non-empty.
 */
export function schemaHasFieldRules(ast: unknown): boolean {
  const models = (ast as { models?: unknown[] } | null)?.models
  if (!Array.isArray(models)) return false
  return models.some((model) => {
    const access = (
      model as { annotations?: { platform?: { access?: Record<string, unknown> } } } | null
    )?.annotations?.platform?.access
    const fields = access?.["fields"]
    return typeof fields === "object" && fields !== null && Object.keys(fields).length > 0
  })
}

/** The tier this project's next push will use. */
export function fieldMaskingTier(config: SupatypeProjectConfig, ast: unknown): FieldMaskingTier {
  if (!schemaHasFieldRules(ast)) return "none"
  return imageShipsMaskExtension(config) ? "extension" : "views"
}

/**
 * The tier for a project on disk, loading its schema to see whether any column is masked.
 *
 * A schema that fails to load falls back to `"none"` — the default exposed-schema list. Deciding the
 * tier is the wrong moment to report a syntax error, and `push`/`dev` do it properly moments later
 * with the file and line.
 */
export function fieldMaskingTierFromProject(
  cwd: string,
  config: SupatypeProjectConfig,
): FieldMaskingTier {
  try {
    const schemaPath = schemaPathFromProject(config, cwd)
    if (!existsSync(schemaPath)) return "none"
    return fieldMaskingTier(config, loadSchemaAst(schemaPath, cwd))
  } catch {
    return "none"
  }
}
