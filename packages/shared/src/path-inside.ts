import { isAbsolute, relative, resolve, sep } from "node:path"

/**
 * Whether `path` lands inside `root`, both resolved on this platform as `path.relative` does. The
 * root itself is not inside it: a file cannot be written to its own folder's path.
 *
 * The answer comes from the relative path, never a string prefix: `/srv/app2` starts with
 * `/srv/app` and is beside it, and `..notes` is a name inside it however it starts. On another
 * drive `relative` answers an absolute path, which is outside.
 */
export function pathInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** `path` resolved against `root` when it lands inside it ({@link pathInside}), otherwise undefined. */
export function resolveInside(root: string, path: string): string | undefined {
  const target = resolve(root, path)
  return pathInside(root, target) ? target : undefined
}
