import { isAbsolute, relative, resolve, sep } from "node:path"

/** Whether the root directory itself counts as inside it. Off by default: a file cannot be written to its own folder's path. */
export interface PathInsideOptions {
  includeRoot?: boolean
}

/**
 * Whether `path` lands inside `root`, both resolved on this platform as `path.relative` does.
 *
 * The answer comes from the relative path, never a string prefix: `/srv/app2` starts with
 * `/srv/app` and is beside it, and `..notes` is a name inside it however it starts. On another
 * drive `relative` answers an absolute path, which is outside.
 */
export function pathInside(root: string, path: string, options: PathInsideOptions = {}): boolean {
  const rel = relative(root, path)
  if (rel === "") return options.includeRoot === true
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** `path` resolved against `root` when it lands inside it ({@link pathInside}), otherwise undefined. */
export function resolveInside(root: string, path: string, options: PathInsideOptions = {}): string | undefined {
  const target = resolve(root, path)
  return pathInside(root, target, options) ? target : undefined
}
