/**
 * Standalone edge-functions worker (per-project or per-function).
 * Routing contract matches CLI-generated `.supatype/functions-router.ts`.
 */

type Handler = (req: Request) => Response | Promise<Response>

interface DiscoveredRoute {
  name: string
  entrypoint: string
}

function functionsRoot(): string {
  const root = (
    Deno.env.get("SUPATYPE_FUNCTIONS_ROOT") ??
    Deno.env.get("SUPATYPE_DENO_FUNCTIONS_DIR") ??
    ""
  ).trim()
  if (!root) {
    throw new Error("SUPATYPE_FUNCTIONS_ROOT (or SUPATYPE_DENO_FUNCTIONS_DIR) is required")
  }
  return root.endsWith("/") ? root.slice(0, -1) : root
}

async function discoverRoutes(root: string): Promise<DiscoveredRoute[]> {
  const single = Deno.env.get("SUPATYPE_FUNCTION_NAME")?.trim()
  const out: DiscoveredRoute[] = []

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

  if (single && out.length === 0) {
    throw new Error(`Function "${single}" not found under ${root}`)
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function entrypointImportUrl(entrypoint: string): string {
  const normalized = entrypoint.replace(/\\/g, "/")
  if (normalized.startsWith("file://")) return normalized
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
const root = functionsRoot()
const routes = await discoverRoutes(root)
const handlers = await loadHandlers(routes)

console.log(
  `[functions-worker] ${Object.keys(handlers).length} handler(s) on :${port}` +
    (Deno.env.get("SUPATYPE_FUNCTION_NAME") ? ` (single: ${Deno.env.get("SUPATYPE_FUNCTION_NAME")})` : ""),
)

const normalizedFunctionsDir = root
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
  const fnName = pathParts[0] ?? ""

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
      const supatypeServiceRole = Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY")
      const supatypeDbUrl = Deno.env.get("SUPATYPE_DB_URL") ?? Deno.env.get("DATABASE_URL")
      const supatypeJwks = Deno.env.get("SUPATYPE_JWKS")

      setScoped("SUPATYPE_URL", supatypeUrl)
      setScoped("SUPATYPE_ANON_KEY", supatypeAnon)
      setScoped("SUPATYPE_SERVICE_ROLE_KEY", supatypeServiceRole)
      setScoped("SUPATYPE_DB_URL", supatypeDbUrl)
      setScoped("SUPATYPE_JWKS", supatypeJwks)
      if (!Deno.env.get("SUPATYPE_PUBLISHABLE_KEYS") && supatypeAnon) {
        setScoped("SUPATYPE_PUBLISHABLE_KEYS", JSON.stringify({ anon: supatypeAnon }))
      }
      if (!Deno.env.get("SUPATYPE_SECRET_KEYS") && supatypeServiceRole) {
        setScoped("SUPATYPE_SECRET_KEYS", JSON.stringify({ service_role: supatypeServiceRole }))
      }

      setScoped("SUPATYPE_REGION", Deno.env.get("SUPATYPE_REGION") ?? "local")
      setScoped("SUPATYPE_EXECUTION_ID", crypto.randomUUID())
      setScoped("DENO_DEPLOYMENT_ID", Deno.env.get("DENO_DEPLOYMENT_ID") ?? "local-dev")

      try {
        return await handlers[fnName]!(req)
      } finally {
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
