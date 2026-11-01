/**
 * Package a project's hooks, and the functions its validators name, for a stack the push reaches over
 * the network: Cloud, or a linked self-host stack (whose control plane writes them back into the
 * project's layout).
 *
 * What a hook may be depends on the target ({@link TargetFunctions.hookFiles}). A managed project
 * has no directory, its worker reads a ConfigMap, whose keys may only contain alphanumerics, `-`,
 * `_` and `.`, so Cloud takes each hook as its one module, flattened here, where it can be checked
 * and explained, rather than in the deploy route where a dropped file would be silent. A server
 * writes the hook's directory back as the project keeps it, so it takes every file the worker loads.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, posix, relative } from "node:path"

import { ADAPTER_IMPORT, ADAPTER_NAME, FLATTENED_ADAPTER_IMPORT, flattenHookSource, type HookMap } from "@supatype/shared"
import { declaredHooks, declaredValidators, manifestHooks } from "./model-hooks.js"
import type { TargetFunctions } from "./resolve-target.js"
import { readWorkerFiles } from "./worker-module-files.js"

/** One handler as the deploy body carries it: its entry, flattened, and for a server every file of it. */
export interface HookHandlerUpload {
  name: string
  /** The entry module, flattened and import-rewritten. */
  source: string
  /** Every file of the hook's directory by its `/` path, as the project keeps it (a server only). */
  files?: Record<string, string>
}

export interface HookUpload {
  handlers: HookHandlerUpload[]
  /** table → event → config, exactly as the manifest would carry it. */
  map: HookMap
}

/** A hook's directory, and how to name it in a message. */
interface HookDir {
  name: string
  dir: string
  /** `<hooks dir>/<name>`, relative to the project. */
  where: string
}

/** Relative specifiers in `source`: `from "./…"` and `import("./…")`, every form resolved against the file's own path. */
function relativeSpecifiers(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) found.add(match[1]!)
  return [...found].sort()
}

/**
 * Read the hooks a schema actually names, and the functions its validators name, ready to upload
 * to a target that takes hooks as `hookFiles` says. Validators name functions in the same directory
 * as hooks, and a stack whose map names a validator it was never sent refuses every write to that
 * column.
 *
 * **Named-only**, not every directory under `hooks/`: an unnamed handler would sit on the worker
 * holding the service-role key with nothing able to call it. Uploading it buys nothing and widens what
 * runs with that credential.
 *
 * Throws with a message meant for a terminal when a handler cannot be uploaded faithfully, the
 * alternative is a deploy that succeeds and a hook that fails to import, which reads to the caller as
 * the table's writes being broken for no visible reason.
 */
export function readHookUpload(
  cwd: string,
  hooksDir: string,
  ast: unknown,
  hookFiles: TargetFunctions["hookFiles"],
): HookUpload | null {
  const declared = [...declaredHooks(ast), ...declaredValidators(ast)]
  if (declared.length === 0) return null
  const names = [...new Set(declared.map((hook) => hook.function))].sort()
  const root = relative(cwd, hooksDir) || hooksDir
  const handlers = names.map((name) => {
    const hook = { name, dir: join(hooksDir, name), where: posix.join(root.replace(/\\/g, "/"), name) }
    if (!existsSync(join(hook.dir, "index.ts"))) throw new Error(`Hook "${name}" has no ${hook.where}/index.ts`)
    return hookFiles === "directory" ? directoryHandler(hook) : entryHandler(hook)
  })
  return { handlers, map: manifestHooks(ast) }
}

/** A hook as Supatype Cloud takes it: its index.ts alone, refused when it needs anything beside it. */
function entryHandler(hook: HookDir): HookHandlerUpload {
  const extra = readdirSync(hook.dir)
    .filter((file) => file !== "index.ts")
    .filter((file) => statSync(join(hook.dir, file)).isFile() || !file.startsWith("."))
  if (extra.length > 0) {
    throw new Error(
      `Hook "${hook.name}" has more than one file (${extra.join(", ")}).\n` +
        "Supatype Cloud serves each hook as its one module, so the others would not be uploaded and " +
        `the hook would fail to import.\nMove what it needs into ${hook.where}/index.ts, or import it ` +
        "by package or URL (npm:, jsr:, https:).",
    )
  }
  const source = readFileSync(join(hook.dir, "index.ts"), "utf8")
  // `../_supatype/hooks.ts` cannot survive flattening, and it is the specifier our own scaffold
  // writes, so it is rewritten (@supatype/shared); any other relative import is refused.
  const unsupported = relativeSpecifiers(source).filter((s) => s !== ADAPTER_IMPORT && s !== FLATTENED_ADAPTER_IMPORT)
  if (unsupported.length > 0) {
    throw new Error(
      `Hook "${hook.name}" imports ${unsupported.join(", ")}, which Supatype Cloud cannot resolve: it ` +
        `serves each hook as its one module.\nOnly the generated ${ADAPTER_IMPORT} survives upload; ` +
        "move the rest into index.ts, or import it by package or URL (npm:, jsr:, https:).",
    )
  }
  return { name: hook.name, source: flattenHookSource(source) }
}

/**
 * A hook as a server takes it: every file of its directory the worker loads, written back as the
 * project keeps it. Refused when a file imports one outside the directory, which is not sent; the
 * generated adapter beside it is.
 */
function directoryHandler(hook: HookDir): HookHandlerUpload {
  const files = readWorkerFiles(hook.dir)
  const outside = Object.entries(files).flatMap(([path, source]) => importsNotSent(path, source, files))
  if (outside.length > 0) {
    throw new Error(
      `Hook "${hook.name}" imports ${outside.join(", ")}, outside ${hook.where}/, which is not uploaded ` +
        "with it.\nMove what it needs into the hook's directory, or import it by package or URL (npm:, jsr:, https:).",
    )
  }
  return { name: hook.name, source: flattenHookSource(files["index.ts"] ?? ""), files }
}

/** Where the generated adapter is, from the hook's directory: sent with every deploy that has hooks. */
const ADAPTER_FROM_HOOK = posix.normalize(ADAPTER_IMPORT)

/** The relative imports of the file at `path` that resolve to no file sent with it, each named with the file it is in. */
function importsNotSent(path: string, source: string, files: Readonly<Record<string, string>>): string[] {
  return relativeSpecifiers(source)
    .filter((specifier) => {
      const resolved = posix.normalize(posix.join(posix.dirname(path), specifier))
      return resolved !== ADAPTER_FROM_HOOK && files[resolved] === undefined
    })
    .map((specifier) => (path === "index.ts" ? specifier : `${specifier} (in ${path})`))
}

/** The generated adapter as a handler-shaped entry, so it travels with them. */
export function adapterEntry(module: string): { name: string; source: string } {
  return { name: ADAPTER_NAME, source: module }
}
