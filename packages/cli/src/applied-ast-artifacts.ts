/**
 * What a push writes from the AST it applied, the same for `push`, Docker dev and native dev: the
 * hook handler types, the functions context module, the manifest's hook, validator and cache maps,
 * and, for a database whose container `.env` configures, the row-cache setting.
 *
 * Each command used to write its own subset. Native dev wrote no context module at all, and Docker
 * dev and `push` worded the same manifest write two ways.
 */
import { refreshFunctionsContext } from "./functions-context-refresh.js"
import { syncRowCacheEnv } from "./model-cache.js"
import { HOOK_MAPS_WRITTEN, syncManifestHooks, writeHooksModule } from "./model-hooks.js"
import { hooksPathFromProject, type SupatypeProjectConfig } from "./project-config.js"

export interface AppliedAstArtifacts {
  /** What was written, a line each, for the caller to print its own way. */
  lines: string[]
  /** The row cache `.env` now asks for, when that changed; the caller says what it takes. */
  rowCache: "on" | "off" | null
}

/**
 * Writes what describes the applied `ast`. `rowCacheEnv`: whether `.env`'s row-cache setting is
 * this project's to write, which it is for the project's own database container and not for
 * native Postgres or a database elsewhere.
 */
export function writeAppliedAstArtifacts(
  cwd: string,
  config: SupatypeProjectConfig,
  ast: unknown,
  { rowCacheEnv }: { rowCacheEnv: boolean },
): AppliedAstArtifacts {
  const lines: string[] = []
  // Independent of `output`: a project with hooks needs its handler types whether or not it asked
  // for client types, and the module is written next to the functions that import it.
  const hooksModule = writeHooksModule(cwd, hooksPathFromProject(config, cwd), ast)
  if (hooksModule !== null) lines.push(`Hook handler types written to ${hooksModule}`)
  // `init` and `functions new` wrote the context module and nothing else did, so a project that
  // already had functions when the two-argument contract landed never received one.
  // The path it wrote, as the project names it (`edge/_shared/context.ts` for functions.path "edge").
  const contextModule = refreshFunctionsContext(cwd, config)
  if (contextModule !== undefined) lines.push(`Function context type written to ${contextModule}`)
  // The server watches the manifest, so a hook or validator added to the schema takes effect
  // without a restart.
  if (syncManifestHooks(cwd, ast)) lines.push(HOOK_MAPS_WRITTEN)
  return { lines, rowCache: rowCacheEnv ? syncRowCacheEnv(cwd, ast) : null }
}
