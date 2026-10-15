/**
 * Which mechanism will enforce this project's per-column rules, decided offline.
 *
 * The engine makes the same decision at push time by asking the database whether `supatype_mask` is
 * installed. The CLI has to answer earlier: it writes `PGRST_DB_SCHEMA` when it generates compose,
 * before any database necessarily exists. It can, because the extension needs
 * `shared_preload_libraries` and a compiled library on the host, so it ships with
 * `supatype/postgres` and with an image built from it; an image configured under another name is
 * asked whether it carries the library. Everything else gets the view tier:
 *
 * | Config                                       | Ships the extension | Tier      |
 * | -------------------------------------------- | ------------------- | --------- |
 * | `database.provider: "docker"`                | yes                 | extension |
 * | `provider: native`                           | no                  | views     |
 * | `database.external`                          | no                  | views     |
 * | `provider: docker` + `database.image` override | asked of the image | either   |
 *
 * Deliberately **not** "is the database external": a native `supatype dev` has no extension either,
 * and treating it as tier 1 would point PostgREST at a schema whose tables the API roles no longer
 * hold privileges on: every request denied.
 *
 * The one case this cannot call is a self-managed Postgres where the operator compiled and installed
 * the extension themselves and points at it with `database.external`. They set `schema.api_schemas`
 * explicitly; `supatype db check` reports the mismatch either way.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
// Statically imported: these packages are ESM, where `require` does not exist. The first attempt used
// it for a lazy import and every command that generates compose would have thrown at runtime, caught
// by the tests that run the built binary rather than the source.
import { loadSchemaAst } from "./config.js"
export { nativeMaskLibraryPresent } from "./postgres-ctl.js"
import { postgresImageFor } from "./postgres-image.js"
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
  return postgresImageFor(config).ref ?? "supatype/postgres:latest"
}

/** True when the Postgres this project runs is one that carries `supatype_mask`. */
export function imageShipsMaskExtension(config: SupatypeProjectConfig): boolean {
  const image = postgresImage(config)
  if (image === undefined) return false
  if (/^supatype\/postgres(:|$)/.test(image)) return true
  return imageCarriesMaskLibrary(image) ?? false
}

/** One answer per image for the life of the process: each costs a container. */
const maskLibraryIn = new Map<string, boolean>()

/**
 * Whether `image` carries the `supatype_mask` library, asked of the image itself, or undefined
 * when it cannot be asked: not on this machine (it is not pulled just to ask), or no Docker.
 *
 * By name alone, a tag of `supatype/postgres` under another name read as having no extension, so
 * the CLI pointed PostgREST at views while the engine, finding the extension, made none (A3-N1).
 */
function imageCarriesMaskLibrary(image: string): boolean | undefined {
  const known = maskLibraryIn.get(image)
  if (known !== undefined) return known
  if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0) return undefined
  const probe = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "sh", image, "-c", 'test -f "$(pg_config --pkglibdir)/supatype_mask.so"'],
    { stdio: "ignore" },
  )
  // 0 found, 1 not found; anything else is Docker failing, which says nothing about the image.
  if (probe.status !== 0 && probe.status !== 1) return undefined
  maskLibraryIn.set(image, probe.status === 0)
  return probe.status === 0
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
export function fieldMaskingTier(
  config: SupatypeProjectConfig,
  ast: unknown,
  /** Set on the native path once the Postgres install is known, see [`nativeMaskLibraryPresent`]. */
  maskLibraryPresent?: boolean,
): FieldMaskingTier {
  if (!schemaHasFieldRules(ast)) return "none"
  if (maskLibraryPresent === true) return "extension"
  return imageShipsMaskExtension(config) ? "extension" : "views"
}

/**
 * The tier for a project on disk, loading its schema to see whether any column is masked.
 *
 * A schema that fails to load falls back to `"none"`, the default exposed-schema list. Deciding the
 * tier is the wrong moment to report a syntax error, and `push`/`dev` do it properly moments later
 * with the file and line.
 */
export function fieldMaskingTierFromProject(
  cwd: string,
  config: SupatypeProjectConfig,
  maskLibraryPresent?: boolean,
): FieldMaskingTier {
  try {
    const schemaPath = schemaPathFromProject(config, cwd)
    if (!existsSync(schemaPath)) return "none"
    return fieldMaskingTier(config, loadSchemaAst(schemaPath, cwd), maskLibraryPresent)
  } catch {
    return "none"
  }
}
