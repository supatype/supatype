/**
 * Standalone edge-functions worker (per-project or per-function).
 * Routing contract matches CLI-generated `.supatype/functions-router.ts`.
 */

import {
  currentHookDepth,
  runInvocation,
  type FunctionContext,
} from "./invocation.ts"
import {
  installStructuredLogging,
  log,
  tailResponse,
} from "./logging.ts"

installStructuredLogging()
// Once, at startup. Hook depth then comes from the invocation store rather than from a patch
// applied and reverted around every call.
installHookDepthPropagation()

/**
 * Route names the worker answers itself.
 *
 * Underscore-prefixed, the convention Deno Deploy and Supabase both use, so a reserved route cannot
 * collide with a function somebody has already deployed. Discovery warns if one is shadowed rather
 * than silently winning.
 */
const RESERVED_ROUTES = new Set(["_logs"])

type Handler = (req: Request, ctx: FunctionContext) => Response | Promise<Response>

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

/**
 * A function's exported handler. A boundary: what can be checked is that it is a function; what it
 * takes and returns is the function author's contract with the worker, which only calling it tests.
 */
function isHandler(value: unknown): value is Handler {
  return typeof value === "function"
}

/** The module's `default` export, else its `handler` export. */
function exportedHandler(mod: unknown): unknown {
  if (typeof mod !== "object" || mod === null) return undefined
  const fallback = "handler" in mod ? mod.handler : undefined
  return ("default" in mod ? mod.default : undefined) ?? fallback
}

async function loadHandlers(routes: DiscoveredRoute[]): Promise<Record<string, Handler>> {
  const handlers: Record<string, Handler> = {}

  for (const route of routes) {
    // The reserved route wins, because the worker answers it before the handler lookup. Say so
    // rather than leaving an author wondering why their function returns an event stream.
    if (RESERVED_ROUTES.has(route.name)) {
      log("warn", `Function "${route.name}" is shadowed: the worker reserves that route`, {
        function: route.name,
      })
      continue
    }
    handlers[route.name] = await loadHandler(route)
  }

  return handlers
}

/**
 * The route's handler, or, when its module fails to import or exports no handler, one that answers
 * the route with a 500 saying why. The first such module used to stop the worker starting, so one
 * broken function took every function in the project down with it.
 */
async function loadHandler(route: DiscoveredRoute): Promise<Handler> {
  try {
    // A module loaded by URL is typed `any`; read its exports as unknown until checked.
    const mod: unknown = await import(entrypointImportUrl(route.entrypoint))
    const handler = exportedHandler(mod)
    if (!isHandler(handler)) throw new Error('it has neither a default export nor a named "handler" export')
    return handler
  } catch (err) {
    const message = `Function "${route.name}" failed to load: ${errorText(err)}`
    log("error", message, { function: route.name })
    return () => jsonError("function_load_failed", message, 500)
  }
}

/** What a thrown value says: an Error's message, anything else as a string. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A JSON error answer, `{ error: code, message, ...extra }`, as every route of the worker gives one. */
function jsonError(code: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: code, message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
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
 * Carry the hook-depth header onto calls a hook makes back into the stack.
 *
 * Patched once, at startup, rather than per invocation. The old version replaced `globalThis.fetch`
 * for the duration of a call and restored it afterwards, which is only safe while exactly one
 * invocation runs at a time: two concurrent hooks would patch over each other, and the first to
 * finish would restore the other's patch. That mutation was half the reason for the lock.
 *
 * Depth comes from the invocation store, so this closure holds no per-call state at all.
 */
function installHookDepthPropagation(): void {
  const original = globalThis.fetch
  globalThis.fetch = (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const depth = currentHookDepth()
    const stack = stackOrigin()
    if (depth === null || stack === null) return original(input, init)

    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(stack)) return original(input, init)

    const request = new Request(input, init)
    request.headers.set(HOOK_DEPTH_HEADER, depth)
    return original(request)
  }
}

/**
 * The database URL a function may use, when the deployment gave the worker one: off unless the
 * operator set SUPATYPE_FUNCTIONS_DB_URL (see `FunctionContext.dbUrl`).
 */
function dbUrlForFunctions(): string | undefined {
  const raw = Deno.env.get("SUPATYPE_DB_URL") ?? Deno.env.get("DATABASE_URL")
  return raw === undefined || raw.trim() === "" ? undefined : raw
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

/**
 * The project's public address, handed to every function as `ctx.publicUrl` (see FunctionContext).
 *
 * Read once, at start: it never differs between invocations, and a deployment that left it unset
 * should be told once rather than on every call. The fallback is `ctx.url`, which under compose is
 * an in-stack name, so a link built from it would reach nobody; the warning says so.
 */
function resolvePublicUrl(): string {
  const configured = (Deno.env.get("SUPATYPE_PUBLIC_URL") ?? "").trim()
  if (configured !== "") return configured
  const internal = Deno.env.get("SUPATYPE_URL") ?? ""
  log(
    "warn",
    "SUPATYPE_PUBLIC_URL is not set, so ctx.publicUrl falls back to ctx.url " +
      `(${internal || "unset"}), which may be an address only this stack can reach`,
  )
  return internal
}

const publicUrl = resolvePublicUrl()


// `onListen` is supplied so Deno does not print its own "Listening on …" line. That line goes to
// stderr, which this worker's patched console reports as `level: "error"`, and on cloud `level` is
// a Loki label, so every startup would appear in the dashboards as an error.
Deno.serve({
  port,
  onListen: ({ hostname, port: bound }) => {
    log("info", `functions-worker listening on http://${hostname}:${bound}`)
  },
}, async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const pathParts = url.pathname.replace(/^\/functions\/v1\/?/, "").split("/").filter(Boolean)
  // A hook is addressed as `hooks/<name>`, so the first segment alone is not the handler key.
  const fnName =
    pathParts[0] === "hooks" && pathParts[1]
      ? HOOKS_ROUTE_PREFIX + pathParts[1]
      : pathParts[0] ?? ""

  // Answered by the worker itself, before the handler lookup, so a project with no functions at all
  // still has a tail.
  if (RESERVED_ROUTES.has(fnName)) {
    if (fnName === "_logs") return tailResponse()
  }

  if (!fnName || !handlers[fnName]) {
    const message = fnName ? `Function "${fnName}" not found` : "No function specified"
    return jsonError("not_found", message, 404, { available: Object.keys(handlers) })
  }

  // Nothing goes into the process environment, so nothing has to be taken back out and nothing has
  // to be serialised. This used to hold a lock across the whole handler, which meant the worker ran
  // one invocation at a time: a function waiting on a third-party API blocked every other function
  // in the project for as long as it waited.
  const dbUrl = dbUrlForFunctions()
  const context: FunctionContext = {
    executionId: crypto.randomUUID(),
    functionName: fnName,
    url: Deno.env.get("SUPATYPE_URL") ?? "",
    publicUrl,
    anonKey: Deno.env.get("SUPATYPE_ANON_KEY") ?? "",
    // From the closure, not the environment: the key was withheld before any handler was imported,
    // and only a route the project granted it receives it here.
    ...(serviceRoleKey && serviceRoleGranted(fnName) && { serviceRoleKey }),
    ...(dbUrl !== undefined && { dbUrl }),
    region: Deno.env.get("SUPATYPE_REGION") ?? "local",
    env: await scopedEnvForFunction(fnName),
  }

  const start = performance.now()

  try {
    const response = await runInvocation(context, req.headers.get(HOOK_DEPTH_HEADER), async () =>
      handlers[fnName]!(req, context),
    )
    log("info", `${req.method} /functions/v1/${fnName} → ${response.status}`, {
      request_id: context.executionId,
      function: fnName,
      status: response.status,
      duration_ms: Number((performance.now() - start).toFixed(1)),
    })
    return response
  } catch (err) {
    const message = errorText(err)
    log("error", message, {
      request_id: context.executionId,
      function: fnName,
      status: 500,
      duration_ms: Number((performance.now() - start).toFixed(1)),
    })
    return jsonError("function_error", message, 500)
  }
})
