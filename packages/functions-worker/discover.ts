/**
 * Finding the functions under a root directory.
 *
 * Kept out of main.ts, which starts a server when imported, so a test can call it on a temporary
 * directory.
 */

export interface DiscoveredRoute {
  name: string
  entrypoint: string
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function isInside(root: string, path: string): boolean {
  const base = normalize(root)
  const target = normalize(path)
  return target === base || target.startsWith(`${base}/`)
}

/**
 * The real path of `path` when it stays inside `realRoot`, otherwise undefined.
 *
 * A Kubernetes ConfigMap volume makes every entry a symlink (`name` -> `..data/name`, `..data` ->
 * `..<timestamp>`), so the scan has to follow links. Following them blindly would let a link
 * planted in the functions directory hand the worker any file it can read, so a target that
 * resolves outside the root is refused. A link loop, a dangling link and an unreadable target make
 * `realPath` throw, and all three mean "not a function here".
 */
async function contained(realRoot: string, path: string): Promise<string | undefined> {
  try {
    const real = await Deno.realPath(path)
    return isInside(realRoot, real) ? real : undefined
  } catch {
    return undefined
  }
}

async function entryKind(path: string): Promise<"dir" | "file" | undefined> {
  try {
    const info = await Deno.stat(path)
    return info.isDirectory ? "dir" : info.isFile ? "file" : undefined
  } catch {
    return undefined
  }
}

async function routeFor(realRoot: string, root: string, name: string): Promise<DiscoveredRoute | undefined> {
  const fullPath = `${root}/${name}`
  if ((await contained(realRoot, fullPath)) === undefined) return undefined
  const kind = await entryKind(fullPath)
  if (kind === "dir") {
    const indexTs = `${fullPath}/index.ts`
    if ((await contained(realRoot, indexTs)) === undefined) return undefined
    return { name, entrypoint: indexTs }
  }
  if (kind === "file" && name.endsWith(".ts") && !name.endsWith(".d.ts")) {
    return { name: name.replace(/\.ts$/, ""), entrypoint: fullPath }
  }
  return undefined
}

export async function discoverRoutes(root: string, single?: string): Promise<DiscoveredRoute[]> {
  const out: DiscoveredRoute[] = []

  // The catch has to wrap the *iteration*: `Deno.readDir` returns its iterable without touching the
  // filesystem, so a missing directory raises NotFound on the first `next()`, not here. A root that
  // does not exist is ordinary, a project with functions but no hooks has no hooks directory, and
  // letting it throw would fail startup and take that project's working functions down with it.
  try {
    const realRoot = await Deno.realPath(root)
    for await (const entry of Deno.readDir(root)) {
      // Hidden entries include the `..data` and `..<timestamp>` a ConfigMap mount adds beside the
      // links; both hold the same functions the links already reach, so loading them doubles every one.
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue
      const route = await routeFor(realRoot, root, entry.name)
      if (route !== undefined && (!single || route.name === single)) out.push(route)
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}
