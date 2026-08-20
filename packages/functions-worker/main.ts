/**
 * Standalone edge-functions worker (per-project or per-function).
 * Routing contract matches CLI-generated `.supatype/functions-router.ts`.
 */

type Handler = (req: Request) => Response | Promise<Response>

interface DiscoveredRoute {
  name: string
  entrypoint: string
}

/**
 * Root for public functions, or "" when this worker serves none.
 *
 * Empty is a real configuration, not a mistake: a per-hook worker mounts a hooks root and nothing else,
 * and its pod has no functions directory to point at. Requiring this one made such a pod crashloop,
 * which the API server sees as the hook refusing to answer, failing every write to its table. Startup
 * still fails when *both* roots are empty, since a worker with no source at all is a misconfiguration.
 */
function functionsRoot(): string {
  const root = (
    Deno.env.get("SUPATYPE_FUNCTIONS_ROOT") ??
    Deno.env.get("SUPATYPE_DENO_FUNCTIONS_DIR") ??
    ""
  ).trim()
  if (!root) return ""
  return root.endsWith("/") ? root.slice(0, -1) : root
}

/**
 * Root for **model hooks**, served under a `hooks/` route prefix.
 *
 * Hooks are procedural: the API server calls them around a write, while everything under the
 * functions root is a public endpoint anyone holding the anon key can invoke. Keeping them in one
 * worker rather than two costs a project no extra pod; keeping them under a route prefix is what lets
 * the gateway refuse them from outside, so the separation is structural rather than a deny-list that
 * a stale manifest could empty.
 */
function hooksRoot(): string {
  const root = (Deno.env.get("SUPATYPE_HOOKS_ROOT") ?? "").trim()
  if (!root) return ""
  return root.endsWith("/") ? root.slice(0, -1) : root
}

/** Route prefix for hook handlers. The gateway refuses this prefix on the public path. */
const HOOKS_ROUTE_PREFIX = "hooks/"

/**
 * Public function routes allowed to see `SUPATYPE_SERVICE_ROLE_KEY`, from
 * `SUPATYPE_SERVICE_ROLE_ROUTES`.
 *
 * Hooks do not appear here: they get the key by default (see serviceRoleGranted). This list is for
 * the public surface, where the default is nothing.
 */
function serviceRoleRoutes(): Set<string> {
  const raw = (Deno.env.get("SUPATYPE_SERVICE_ROLE_ROUTES") ?? "").trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
}

/**
 * Take the service-role key out of the process environment, returning it for scoped re-injection.
 *
 * **Before handlers are imported**, which is the whole point: a handler's module body runs at import
 * time, so a key still in `Deno.env` then is a key any handler can copy and keep. Withholding it
 * afterwards would be theatre.
 *
 * The default is now "no admin credential". A function is a public endpoint, anyone holding the anon
 * key can invoke one, and an ambient service-role key made every one of them able to read and write
 * past every access rule in the schema. Opting in is a line in `supatype.config.ts`, which is
 * reviewable; ambient privilege is not.
 */
/**
 * Whether a route may see the service-role key.
 *
 * **Hooks: yes.** A hook is procedural, only the API server calls it, around a write the caller was
 * already permitted to make, and the gateway refuses its route from outside, so it is not reachable
 * by anyone who could choose to invoke it. Requiring each one to be listed would be friction with no
 * attacker to stop, and it is the same trust a trigger or a migration already has.
 *
 * **Public functions: only if named.** Those *are* invocable by anyone holding the anon key, so an
 * ambient admin credential there is read and write access past every access rule in the schema,
 * handed to code the internet can call.
 */
function serviceRoleGranted(route: string): boolean {
  if (route.startsWith(HOOKS_ROUTE_PREFIX)) return true
  return serviceRoleAllowed.has(route)
}

function withholdServiceRoleKey(): string {
  const key = Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? ""
  if (key) Deno.env.delete("SUPATYPE_SERVICE_ROLE_KEY")
  return key
}

async function discoverRoutes(root: string): Promise<DiscoveredRoute[]> {
  const single = Deno.env.get("SUPATYPE_FUNCTION_NAME")?.trim()
  const out: DiscoveredRoute[] = []

  // The catch has to wrap the *iteration*: `Deno.readDir` returns its iterable without touching the
  // filesystem, so a missing directory raises NotFound on the first `next()`, not here. A root that
  // does not exist is ordinary, a project with functions but no hooks has no hooks directory, and
  // letting it throw would fail startup and take that project's working functions down with it.
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue

      const fullPath = `${root}/${entry.name}`

      if (entry.isDirectory) {
        const indexTs = `${fullPath}/index.ts`
        try {
          await Deno.stat(indexTs)
          if (!single || entry.name === single) {
            out.push({ name: entry.name, entrypoint: indexTs })
          }
        } catch {
          // no index.ts
        }
      } else if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const name = entry.name.replace(/\.ts$/, "")
        if (!single || name === single) {
          out.push({ name, entrypoint: fullPath })
        }
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function entrypointImportUrl(entrypoint: string): string {
  const normalized = entrypoint.replace(/\\/g, "/")
  if (normalized.startsWith("file://")) return normalized
  // A Windows absolute path is not a URL: `new URL("C:/x")` reads the drive letter as the scheme, and
  // Deno then refuses to import scheme "c". Invisible in a Linux container, where every root starts
  // with "/", and fatal the moment this worker runs on a developer's machine.
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}`
  if (normalized.startsWith("/")) return `file://${normalized}`
  return new URL(normalized, import.meta.url).href
}

async function loadHandlers(routes: DiscoveredRoute[]): Promise<Record<string, Handler>> {
  const handlers: Record<string, Handler> = {}

  for (const route of routes) {
    const mod = await import(entrypointImportUrl(route.entrypoint))
    const handler = mod.default ?? mod.handler
    if (typeof handler !== "function") {
      throw new Error(`Function "${route.name}" has no default export handler`)
    }
    handlers[route.name] = handler as Handler
  }

  return handlers
}

const port = parseInt(Deno.env.get("PORT") ?? "8001", 10)
// Order matters: withhold, then import. See withholdServiceRoleKey.
const serviceRoleKey = withholdServiceRoleKey()
const serviceRoleAllowed = serviceRoleRoutes()
const root = functionsRoot()
const routes = root ? await discoverRoutes(root) : []
const handlers = await loadHandlers(routes)

// Hooks are namespaced so one worker can serve both without a name in `hooks/` ever shadowing, or
// being reachable as: a public function of the same name.
const hooksDir = hooksRoot()
if (!root && !hooksDir) {
  throw new Error(
    "SUPATYPE_FUNCTIONS_ROOT or SUPATYPE_HOOKS_ROOT is required (a worker with neither serves nothing)",
  )
}
if (hooksDir) {
  const hookRoutes = await discoverRoutes(hooksDir)
  const hookHandlers = await loadHandlers(hookRoutes)
  for (const [name, handler] of Object.entries(hookHandlers)) {
    handlers[HOOKS_ROUTE_PREFIX + name] = handler
  }
}

// A worker pinned to one route still has to find it, and with two roots "absent from this one" is not
// "absent everywhere": a per-hook pod names its hook and has no functions directory at all. Checked
// once, after both roots, so the failure means what it says, and it stays a failure, because a pod
// serving nothing would answer 404 to the API server, which reads as the hook refusing to answer and
// fails every write to its table.
const single = Deno.env.get("SUPATYPE_FUNCTION_NAME")?.trim()
if (single && Object.keys(handlers).length === 0) {
  throw new Error(
    `Handler "${single}" not found under ${root}` + (hooksDir ? ` or ${hooksDir}` : ""),
  )
}

console.log(
  `[functions-worker] ${Object.keys(handlers).length} handler(s) on :${port}` +
    (Deno.env.get("SUPATYPE_FUNCTION_NAME") ? ` (single: ${Deno.env.get("SUPATYPE_FUNCTION_NAME")})` : ""),
)

// Falls back to the hooks root: a per-hook worker has no functions directory, and the shared env file
// is looked for beside whichever source this worker actually has.
const normalizedFunctionsDir = root || hooksDir
const sharedEnvPath =
  Deno.env.get("SUPATYPE_SHARED_ENV_FILE") ?? `${normalizedFunctionsDir}/.env.local`

let envLock: Promise<void> = Promise.resolve()

async function withEnvLock<T>(run: () => Promise<T>): Promise<T> {
  const prev = envLock
  let release: () => void = () => {}
  envLock = new Promise<void>((resolve) => {
    release = resolve
  })
  await prev
  try {
    return await run()
  } finally {
    release()
  }
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (!path) return {}
  try {
    const text = await Deno.readTextFile(path)
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return out
  } catch {
    return {}
  }
}

async function scopedEnvForFunction(fnName: string): Promise<Record<string, string>> {
  const shared = await readEnvFile(sharedEnvPath)
  const fnPath = `${normalizedFunctionsDir}/.env.${fnName}.local`
  const fnVars = await readEnvFile(fnPath)
  return { ...shared, ...fnVars }
}

const HOOK_DEPTH_HEADER = "x-supatype-hook-depth"

/**
 * Carry the hook chain's depth onto whatever the handler calls the stack with.
 *
 * A hook receives the service-role key, so a hook that writes to its own table re-enters the API and
 * calls itself again: `service_role` decides what Postgres permits, not whether the hook middleware
 * runs. The server refuses past a small depth, but only if the count survives the hop through a
 * handler, and a handler writes with whatever client it likes.
 *
 * So the count is attached here rather than asked of the handler: `fetch` is what every client is built
 * on, and patching it for the invocation means a hook cannot skip the guard by accident. Scoped and
 * restored like the environment above, and safe for the same reason, invocations hold the env lock, so
 * one runs at a time.
 *
 * Only for hooks, and only for requests to this stack: a handler calling a payment API must not leak
 * an internal header to it.
 */
function carryHookDepth(req: Request, fnName: string): () => void {
  const depth = req.headers.get(HOOK_DEPTH_HEADER)
  if (!fnName.startsWith(HOOKS_ROUTE_PREFIX) || depth === null) return () => {}

  const stack = stackOrigin()
  if (stack === null) return () => {}

  const original = globalThis.fetch
  globalThis.fetch = (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(stack)) return original(input, init)

    const request = new Request(input as Request, init)
    request.headers.set(HOOK_DEPTH_HEADER, depth)
    return original(request)
  }
  return () => {
    globalThis.fetch = original
  }
}

/** The stack's own origin, or null when this worker was not told how to reach it. */
function stackOrigin(): string | null {
  const raw = Deno.env.get("SUPATYPE_INTERNAL_URL") ?? Deno.env.get("SUPATYPE_URL")
  if (raw === undefined || raw.trim() === "") return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

async function runWithScopedEnv<T>(fnName: string, run: () => Promise<T>): Promise<T> {
  return withEnvLock(async () => {
    const scoped = await scopedEnvForFunction(fnName)
    const prev = new Map<string, string | undefined>()
    for (const [k, v] of Object.entries(scoped)) {
      prev.set(k, Deno.env.get(k))
      Deno.env.set(k, v)
    }
    try {
      return await run()
    } finally {
      for (const k of Object.keys(scoped)) {
        const old = prev.get(k)
        if (old === undefined) Deno.env.delete(k)
        else Deno.env.set(k, old)
      }
    }
  })
}

Deno.serve({ port }, async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const pathParts = url.pathname.replace(/^\/functions\/v1\/?/, "").split("/").filter(Boolean)
  // A hook is addressed as `hooks/<name>`, so the first segment alone is not the handler key.
  const fnName =
    pathParts[0] === "hooks" && pathParts[1]
      ? HOOKS_ROUTE_PREFIX + pathParts[1]
      : pathParts[0] ?? ""

  if (!fnName || !handlers[fnName]) {
    return new Response(
      JSON.stringify({
        error: "not_found",
        message: fnName ? `Function "${fnName}" not found` : "No function specified",
        available: Object.keys(handlers),
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }

  try {
    const start = performance.now()
    const response = await runWithScopedEnv(fnName, async () => {
      const prev = new Map<string, string | undefined>()
      const setScoped = (key: string, value: string | undefined) => {
        if (value === undefined || value.length === 0) return
        prev.set(key, Deno.env.get(key))
        Deno.env.set(key, value)
      }

      const supatypeUrl = Deno.env.get("SUPATYPE_URL")
      const supatypeAnon = Deno.env.get("SUPATYPE_ANON_KEY")
      // The key is not in the process environment, it was withheld before any handler was imported.
      // It comes from the closure, and only for a route that asked for it.
      //
      // Read from the closure rather than re-injected before this block: `setScoped` captures the
      // *current* value as the one to restore afterwards, so injecting first made the restore put the
      // grant back permanently: a leak into every later call, which is what the test caught.
      const supatypeServiceRole = serviceRoleKey && serviceRoleGranted(fnName) ? serviceRoleKey : undefined
      const supatypeDbUrl = Deno.env.get("SUPATYPE_DB_URL") ?? Deno.env.get("DATABASE_URL")
      // No SUPATYPE_JWKS. It was read here and set by nothing, and the shape is a trap: with the
      // default HS256 signing the only "key" to put in it is the symmetric secret, which is the power
      // to *mint* a service_role token, not merely to verify one, strictly worse than the ambient
      // service-role key removed in this same series. A function verifies a caller by asking
      // `/auth/v1/user`, or simply acts as the caller and lets RLS answer. Where a project configures
      // asymmetric JWT keys, `/auth/v1/.well-known/jwks.json` serves the public half and rotates.

      setScoped("SUPATYPE_URL", supatypeUrl)
      setScoped("SUPATYPE_ANON_KEY", supatypeAnon)
      setScoped("SUPATYPE_SERVICE_ROLE_KEY", supatypeServiceRole)
      setScoped("SUPATYPE_DB_URL", supatypeDbUrl)
      if (!Deno.env.get("SUPATYPE_PUBLISHABLE_KEYS") && supatypeAnon) {
        setScoped("SUPATYPE_PUBLISHABLE_KEYS", JSON.stringify({ anon: supatypeAnon }))
      }
      if (!Deno.env.get("SUPATYPE_SECRET_KEYS") && supatypeServiceRole) {
        setScoped("SUPATYPE_SECRET_KEYS", JSON.stringify({ service_role: supatypeServiceRole }))
      }

      setScoped("SUPATYPE_REGION", Deno.env.get("SUPATYPE_REGION") ?? "local")
      setScoped("SUPATYPE_EXECUTION_ID", crypto.randomUUID())
      setScoped("DENO_DEPLOYMENT_ID", Deno.env.get("DENO_DEPLOYMENT_ID") ?? "local-dev")

      const restoreFetch = carryHookDepth(req, fnName)
      try {
        return await handlers[fnName]!(req)
      } finally {
        restoreFetch()
        for (const [key, old] of prev.entries()) {
          if (old === undefined) Deno.env.delete(key)
          else Deno.env.set(key, old)
        }
      }
    })
    const duration = (performance.now() - start).toFixed(1)
    console.log(`${req.method} /functions/v1/${fnName} → ${response.status} (${duration}ms)`)
    return response
  } catch (err) {
    console.error(`Error in function "${fnName}":`, err)
    return new Response(
      JSON.stringify({
        error: "function_error",
        message: err instanceof Error ? err.message : "Unknown error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
})
