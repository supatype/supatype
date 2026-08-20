/**
 * Package a project's hooks for a managed stack.
 *
 * Self-hosted stacks need none of this: the worker mounts the project directory, so `hooks/` is already
 * where it looks. A managed project has no directory, its worker reads a ConfigMap, whose keys may only
 * contain alphanumerics, `-`, `_` and `.`. So the tree is flattened here, where it can be checked and
 * explained, rather than in the deploy route where a dropped file would be silent.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { declaredHooks, manifestHooks, type ManifestHookEntry } from "./model-hooks.js"

/** The generated adapter, flattened. `_`-prefixed, so the worker never routes to it. */
export const ADAPTER_KEY = "_supatype-hooks.ts"

/** What the handlers import locally, and what has to be rewritten to reach the flattened name. */
const ADAPTER_IMPORT = "../_supatype/hooks.ts"

export interface HookUpload {
  /** Handler name → its source, flattened and import-rewritten. */
  handlers: Array<{ name: string; source: string }>
  /** table → event → config, exactly as the manifest would carry it. */
  map: Record<string, Record<string, ManifestHookEntry>>
}

/**
 * Rewrite the one import a hook handler is generated to make.
 *
 * `../_supatype/hooks.ts` is a path that cannot survive flattening, and it is the specifier our own
 * scaffold writes: so it is rewritten rather than refused. Any *other* relative import is refused
 * below: it would resolve to nothing on the worker, and a hook that fails to import is a hooked table
 * whose writes all start failing.
 */
function rewriteAdapterImport(source: string): string {
  return source.split(ADAPTER_IMPORT).join(`./${ADAPTER_KEY}`)
}

/** Relative specifiers a flattened layout cannot honour, so the caller can refuse with a real reason. */
function unsupportedImports(source: string): string[] {
  const found = new Set<string>()
  // Matches `from "…"` and `import("…")`, which is every form that resolves against the file's own path.
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) {
    const specifier = match[1]!
    if (specifier === ADAPTER_IMPORT || specifier === `./${ADAPTER_KEY}`) continue
    found.add(specifier)
  }
  return [...found].sort()
}

/**
 * Read the hooks a schema actually names, ready to upload.
 *
 * **Named-only**, not every directory under `hooks/`: an unnamed handler would sit on the worker
 * holding the service-role key with nothing able to call it. Uploading it buys nothing and widens what
 * runs with that credential.
 *
 * Throws with a message meant for a terminal when a handler cannot be flattened faithfully, the
 * alternative is a deploy that succeeds and a hook that fails to import, which reads to the caller as
 * the table's writes being broken for no visible reason.
 */
export function readHookUpload(cwd: string, hooksDir: string, ast: unknown): HookUpload | null {
  const declared = declaredHooks(ast)
  if (declared.length === 0) return null

  const names = [...new Set(declared.map((hook) => hook.function))].sort()
  const where = relative(cwd, hooksDir) || hooksDir
  const handlers: Array<{ name: string; source: string }> = []

  for (const name of names) {
    const dir = join(hooksDir, name)
    const entry = join(dir, "index.ts")
    if (!existsSync(entry)) {
      throw new Error(`Hook "${name}" has no ${where}/${name}/index.ts`)
    }

    const extra = readdirSync(dir)
      .filter((file) => file !== "index.ts")
      .filter((file) => statSync(join(dir, file)).isFile() || !file.startsWith("."))
    if (extra.length > 0) {
      throw new Error(
        `Hook "${name}" has more than one file (${extra.join(", ")}).\n` +
          `A managed stack serves each hook as a single module today, so the others would not be ` +
          `uploaded and the hook would fail to import.\nMove what it needs into index.ts, or run this ` +
          `hook on a self-hosted stack, which mounts the directory as it is.`,
      )
    }

    const source = readFileSync(entry, "utf8")
    const unsupported = unsupportedImports(source)
    if (unsupported.length > 0) {
      throw new Error(
        `Hook "${name}" imports ${unsupported.join(", ")}, which a managed stack cannot resolve.\n` +
          `Only the generated ${ADAPTER_IMPORT} survives upload; bare specifiers and URLs are fine.`,
      )
    }

    handlers.push({ name, source: rewriteAdapterImport(source) })
  }

  return { handlers, map: manifestHooks(ast) }
}

/** The generated adapter as a handler-shaped entry, so it travels with them. */
export function adapterEntry(module: string): { name: string; source: string } {
  return { name: ADAPTER_KEY.replace(/\.ts$/, ""), source: module }
}
