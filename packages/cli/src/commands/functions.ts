import type { Command } from "commander"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs"
import { resolve, join, basename, relative } from "node:path"
import { spawnSync, execSync } from "node:child_process"

// ─── Constants ───────────────────────────────────────────────────────────────

const FUNCTIONS_DIR = "supatype/functions"
const SHARED_DIR = "_shared"
const ENV_LOCAL = ".env.local"
const ENV_PRODUCTION = ".env.production"

// ─── Registration ────────────────────────────────────────────────────────────

export function registerFunctions(program: Command): void {
  const fnCmd = program
    .command("functions")
    .description("Manage Supatype Edge Functions (Deno-based serverless TypeScript)")

  fnCmd
    .command("new <name>")
    .description("Scaffold a new edge function")
    .action((name: string) => {
      scaffoldFunction(process.cwd(), name)
    })

  fnCmd
    .command("serve")
    .description("Start a local Deno server that serves all functions with hot reload")
    .option("--port <port>", "Port to serve on", "54321")
    .option("--env-file <path>", "Path to env file", `${FUNCTIONS_DIR}/${ENV_LOCAL}`)
    .action((opts: { port: string; envFile: string }) => {
      serve(process.cwd(), opts)
    })

  fnCmd
    .command("deploy")
    .description("Deploy all functions (or --only <name> for one) to the linked project")
    .option("--only <name>", "Deploy a single function")
    .option("--dry-run", "Show what would be deployed without deploying")
    .action(async (opts: { only?: string; dryRun?: boolean }) => {
      await deploy(process.cwd(), opts)
    })

  fnCmd
    .command("list")
    .description("List all deployed functions for the linked project")
    .action(async () => {
      await listFunctions(process.cwd())
    })

  fnCmd
    .command("delete <name>")
    .description("Remove a deployed function")
    .action(async (name: string) => {
      await deleteFunction(process.cwd(), name)
    })

  fnCmd
    .command("logs <name>")
    .description("Tail logs for a deployed function")
    .option("--since <duration>", "Show logs since duration (e.g. 1h, 30m)", "1h")
    .action(async (name: string, opts: { since: string }) => {
      await functionLogs(process.cwd(), name, opts)
    })

  fnCmd
    .command("invoke <name>")
    .description("Invoke a local or deployed function")
    .option("--data <json>", "JSON body to send", "{}")
    .option("--auth", "Include a test JWT in the request")
    .option("--local", "Invoke the local dev server (default if serve is running)")
    .action(async (name: string, opts: { data: string; auth?: boolean; local?: boolean }) => {
      await invoke(process.cwd(), name, opts)
    })

  const envCmd = fnCmd
    .command("env")
    .description("Manage function environment variables")

  envCmd
    .command("list")
    .description("List environment variables (values masked)")
    .action(async () => {
      await envList(process.cwd())
    })

  envCmd
    .command("set <keyvalue>")
    .description("Set an environment variable (KEY=value)")
    .action(async (keyvalue: string) => {
      await envSet(process.cwd(), keyvalue)
    })

  envCmd
    .command("unset <key>")
    .description("Remove an environment variable")
    .action(async (key: string) => {
      await envUnset(process.cwd(), key)
    })
}

// ─── Scaffold ────────────────────────────────────────────────────────────────

function scaffoldFunction(cwd: string, name: string): void {
  const fnDir = resolve(cwd, FUNCTIONS_DIR, name)
  if (existsSync(fnDir)) {
    console.error(`Function "${name}" already exists at ${relative(cwd, fnDir)}`)
    process.exit(1)
  }

  mkdirSync(fnDir, { recursive: true })

  const indexContent = `// ${name} — Supatype Edge Function
// Docs: https://supatype.dev/docs/edge-functions

export default async function handler(req: Request): Promise<Response> {
  const { method, url } = req

  // Example: read request body for POST requests
  if (method === "POST") {
    const body = await req.json()
    return new Response(JSON.stringify({ message: "Hello from ${name}!", received: body }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify({ message: "Hello from ${name}!" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
`

  writeFileSync(join(fnDir, "index.ts"), indexContent, "utf8")

  // Ensure _shared directory exists
  const sharedDir = resolve(cwd, FUNCTIONS_DIR, SHARED_DIR)
  if (!existsSync(sharedDir)) {
    mkdirSync(sharedDir, { recursive: true })
    writeFileSync(
      join(sharedDir, "README.md"),
      "# Shared Code\n\nFiles in `_shared/` are available to all functions via relative imports.\nThis directory is not deployed as a function.\n\nExample: `import { sendEmail } from '../_shared/email.ts'`\n",
      "utf8",
    )
  }

  // Ensure .env.local exists
  const envLocalPath = resolve(cwd, FUNCTIONS_DIR, ENV_LOCAL)
  if (!existsSync(envLocalPath)) {
    writeFileSync(
      envLocalPath,
      "# Local environment variables for edge functions\n# These are NOT committed to git\n# Set production env vars via: npx supatype functions env set KEY=value\n",
      "utf8",
    )
  }

  console.log(`Created function: ${FUNCTIONS_DIR}/${name}/index.ts`)
  console.log()
  console.log("  Local dev:    npx supatype functions serve")
  console.log(`  Invoke:       npx supatype functions invoke ${name}`)
  console.log("  Deploy:       npx supatype functions deploy")
}

// ─── Discover functions ──────────────────────────────────────────────────────

interface DiscoveredFunction {
  name: string
  entrypoint: string
  absPath: string
}

function discoverFunctions(cwd: string): DiscoveredFunction[] {
  const functionsDir = resolve(cwd, FUNCTIONS_DIR)
  if (!existsSync(functionsDir)) return []

  const entries = readdirSync(functionsDir)
  const fns: DiscoveredFunction[] = []

  for (const entry of entries) {
    if (entry.startsWith("_") || entry.startsWith(".")) continue

    const fullPath = join(functionsDir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      // Directory function — look for index.ts
      const indexPath = join(fullPath, "index.ts")
      if (existsSync(indexPath)) {
        fns.push({ name: entry, entrypoint: indexPath, absPath: fullPath })
      }
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      // Single-file function
      const name = basename(entry, ".ts")
      fns.push({ name, entrypoint: fullPath, absPath: fullPath })
    }
  }

  return fns.sort((a, b) => a.name.localeCompare(b.name))
}

// ─── Serve (local dev) ──────────────────────────────────────────────────────

function serve(cwd: string, opts: { port: string; envFile: string }): void {
  const fns = discoverFunctions(cwd)
  if (fns.length === 0) {
    console.error(`No functions found in ${FUNCTIONS_DIR}/`)
    console.error("Create one with: npx supatype functions new <name>")
    process.exit(1)
  }

  console.log(`Discovered ${fns.length} function(s):`)
  for (const fn of fns) {
    console.log(`  /${fn.name}  →  ${relative(cwd, fn.entrypoint)}`)
  }
  console.log()

  // Generate a Deno entry script that routes requests to the correct function
  const routerScript = generateLocalRouter(fns, cwd)
  const routerPath = resolve(cwd, FUNCTIONS_DIR, ".serve-router.ts")
  writeFileSync(routerPath, routerScript, "utf8")

  const envFilePath = resolve(cwd, opts.envFile)
  const envArgs: string[] = []
  if (existsSync(envFilePath)) {
    envArgs.push("--env-file", envFilePath)
  }

  console.log(`Serving functions at http://localhost:${opts.port}/functions/v1/`)
  console.log("Watching for changes...\n")

  const result = spawnSync(
    "deno",
    [
      "run",
      "--allow-net",
      "--allow-env",
      "--allow-read",
      "--watch",
      ...envArgs,
      routerPath,
    ],
    {
      stdio: "inherit",
      cwd,
      env: {
        ...process.env,
        PORT: opts.port,
        SUPATYPE_URL: process.env["SUPATYPE_URL"] ?? `http://localhost:8000`,
        SUPATYPE_ANON_KEY: process.env["SUPATYPE_ANON_KEY"] ?? "",
        SUPATYPE_SERVICE_ROLE_KEY: process.env["SUPATYPE_SERVICE_ROLE_KEY"] ?? "",
      },
    },
  )

  // Clean up router script
  try { unlinkSync(routerPath) } catch { /* ignore */ }

  if (result.status !== 0) {
    console.error("Function server exited with errors.")
    console.error("Make sure Deno is installed: https://deno.land/manual/getting_started/installation")
    process.exit(result.status ?? 1)
  }
}

function generateLocalRouter(fns: DiscoveredFunction[], cwd: string): string {
  const imports = fns.map(
    (fn, i) => `import handler_${i} from "./${relative(resolve(cwd, FUNCTIONS_DIR), fn.entrypoint).replace(/\\/g, "/")}"`,
  )

  const routes = fns.map(
    (fn, i) => `  "${fn.name}": handler_${i},`,
  )

  return `// Auto-generated local function router — do not edit
${imports.join("\n")}

const handlers: Record<string, (req: Request) => Response | Promise<Response>> = {
${routes.join("\n")}
}

const port = parseInt(Deno.env.get("PORT") ?? "54321", 10)

Deno.serve({ port }, async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const pathParts = url.pathname.replace(/^\\/functions\\/v1\\//, "").split("/")
  const fnName = pathParts[0] ?? ""

  if (!fnName || !handlers[fnName]) {
    return new Response(JSON.stringify({
      error: "not_found",
      message: fnName ? \`Function "\${fnName}" not found\` : "No function specified",
      available: Object.keys(handlers),
    }), { status: 404, headers: { "Content-Type": "application/json" } })
  }

  try {
    const start = performance.now()
    const response = await handlers[fnName]!(req)
    const duration = (performance.now() - start).toFixed(1)
    console.log(\`\${req.method} /functions/v1/\${fnName} → \${response.status} (\${duration}ms)\`)
    return response
  } catch (err) {
    console.error(\`Error in function "\${fnName}":\`, err)
    return new Response(JSON.stringify({
      error: "function_error",
      message: err instanceof Error ? err.message : "Unknown error",
    }), { status: 500, headers: { "Content-Type": "application/json" } })
  }
})

console.log(\`Edge function server running on http://localhost:\${port}/functions/v1/\`)
`
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

async function deploy(cwd: string, opts: { only?: string; dryRun?: boolean }): Promise<void> {
  const allFns = discoverFunctions(cwd)
  const fns = opts.only
    ? allFns.filter(f => f.name === opts.only)
    : allFns

  if (fns.length === 0) {
    if (opts.only) {
      console.error(`Function "${opts.only}" not found in ${FUNCTIONS_DIR}/`)
    } else {
      console.error(`No functions found in ${FUNCTIONS_DIR}/`)
    }
    process.exit(1)
  }

  if (opts.dryRun) {
    console.log("Dry run — the following functions would be deployed:\n")
    for (const fn of fns) {
      console.log(`  ${fn.name}  →  ${relative(cwd, fn.entrypoint)}`)
    }
    console.log(`\nTotal: ${fns.length} function(s)`)
    return
  }

  // Check if this is a self-hosted deployment or cloud
  const isSelfHosted = detectSelfHosted(cwd)

  if (isSelfHosted) {
    await deploySelfHosted(cwd, fns)
  } else {
    await deployCloud(cwd, fns)
  }
}

function detectSelfHosted(cwd: string): boolean {
  return existsSync(resolve(cwd, "deploy/docker-compose.yml"))
}

async function deploySelfHosted(cwd: string, fns: DiscoveredFunction[]): Promise<void> {
  console.log("Self-hosted deployment detected.\n")
  console.log("Bundling functions...\n")

  const bundleDir = resolve(cwd, "deploy/functions")
  mkdirSync(bundleDir, { recursive: true })

  for (const fn of fns) {
    const start = Date.now()
    const outFile = join(bundleDir, `${fn.name}.js`)

    // Bundle with Deno
    const result = spawnSync("deno", ["bundle", fn.entrypoint, outFile], {
      stdio: "pipe",
      cwd,
    })

    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? ""
      console.error(`  ${fn.name} ✗ bundle failed`)
      if (stderr) console.error(`    ${stderr.trim()}`)
      continue
    }

    const duration = Date.now() - start
    console.log(`  ${fn.name} ✓ deployed (${duration}ms)`)
  }

  console.log(`\nDeployed ${fns.length} function(s) to deploy/functions/`)
  console.log("The supatype-functions container will pick up changes automatically.")
}

async function deployCloud(cwd: string, fns: DiscoveredFunction[]): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    console.error("No linked project. Run: npx supatype cloud link")
    process.exit(1)
  }

  const token = getCloudToken()
  if (!token) {
    console.error("Not logged in. Run: npx supatype cloud login")
    process.exit(1)
  }

  const apiUrl = getCloudApiUrl()
  console.log(`Deploying to project: ${linked.ref}\n`)

  for (const fn of fns) {
    const start = Date.now()

    // Read source code
    const source = readFunctionSource(fn)

    try {
      const res = await fetch(`${apiUrl}/api/v1/projects/${linked.ref}/functions/deploy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Org-Id": linked.orgId ?? "",
        },
        body: JSON.stringify({
          functions: [{
            name: fn.name,
            source,
            entrypoint: `${fn.name}/index.ts`,
          }],
        }),
        signal: AbortSignal.timeout(60_000),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, string>
        console.error(`  ${fn.name} ✗ ${body["message"] ?? res.statusText}`)
        continue
      }

      const duration = Date.now() - start
      console.log(`  ${fn.name} ✓ deployed (${duration}ms)`)
    } catch (err) {
      console.error(`  ${fn.name} ✗ ${err instanceof Error ? err.message : "unknown error"}`)
    }
  }

  console.log(`\nDeployed ${fns.length} function(s)`)
  console.log(`Invoke: https://${linked.ref}.supatype.io/functions/v1/<name>`)
}

function readFunctionSource(fn: DiscoveredFunction): string {
  const stat = statSync(fn.absPath)
  if (stat.isFile()) {
    return readFileSync(fn.absPath, "utf8")
  }

  // Directory function — read all .ts files
  const files: Record<string, string> = {}
  const entries = readdirSync(fn.absPath, { recursive: true }) as string[]
  for (const entry of entries) {
    const fullPath = join(fn.absPath, entry)
    if (statSync(fullPath).isFile() && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
      files[entry] = readFileSync(fullPath, "utf8")
    }
  }
  return JSON.stringify(files)
}

// ─── List ────────────────────────────────────────────────────────────────────

async function listFunctions(cwd: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    // Show local functions instead
    const fns = discoverFunctions(cwd)
    if (fns.length === 0) {
      console.log("No functions found locally or remotely.")
      return
    }
    console.log("Local functions (not linked to a cloud project):\n")
    for (const fn of fns) {
      console.log(`  ${fn.name.padEnd(30)} ${relative(cwd, fn.entrypoint)}`)
    }
    return
  }

  const token = getCloudToken()
  if (!token) {
    console.error("Not logged in. Run: npx supatype cloud login")
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl()}/api/v1/projects/${linked.ref}/functions`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": linked.orgId ?? "",
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      console.error(`Failed to list functions: ${res.statusText}`)
      process.exit(1)
    }

    const { data } = await res.json() as { data: Array<{ name: string; deployedAt: string; invocations24h: number; avgDurationMs: number }> }

    if (data.length === 0) {
      console.log("No deployed functions.")
      return
    }

    console.log("Deployed functions:\n")
    console.log(`  ${"Name".padEnd(28)} ${"Last Deployed".padEnd(24)} ${"Invocations (24h)".padEnd(20)} Avg Duration`)
    console.log(`  ${"─".repeat(28)} ${"─".repeat(24)} ${"─".repeat(20)} ${"─".repeat(12)}`)

    for (const fn of data) {
      const deployed = fn.deployedAt ? new Date(fn.deployedAt).toLocaleString() : "—"
      console.log(
        `  ${fn.name.padEnd(28)} ${deployed.padEnd(24)} ${String(fn.invocations24h ?? 0).padEnd(20)} ${fn.avgDurationMs ?? 0}ms`,
      )
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : "unknown"}`)
    process.exit(1)
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function deleteFunction(cwd: string, name: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    console.error("No linked project. Run: npx supatype cloud link")
    process.exit(1)
  }

  const token = getCloudToken()
  if (!token) {
    console.error("Not logged in. Run: npx supatype cloud login")
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl()}/api/v1/projects/${linked.ref}/functions/${name}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": linked.orgId ?? "",
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>
      console.error(`Failed to delete "${name}": ${body["message"] ?? res.statusText}`)
      process.exit(1)
    }

    console.log(`Function "${name}" deleted. It will return 404 immediately.`)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : "unknown"}`)
    process.exit(1)
  }
}

// ─── Logs ────────────────────────────────────────────────────────────────────

async function functionLogs(cwd: string, name: string, opts: { since: string }): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    console.error("No linked project. Run: npx supatype cloud link")
    process.exit(1)
  }

  const token = getCloudToken()
  if (!token) {
    console.error("Not logged in. Run: npx supatype cloud login")
    process.exit(1)
  }

  try {
    const res = await fetch(
      `${getCloudApiUrl()}/api/v1/projects/${linked.ref}/functions/${name}/logs?since=${opts.since}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Org-Id": linked.orgId ?? "",
        },
        signal: AbortSignal.timeout(10_000),
      },
    )

    if (!res.ok) {
      console.error(`Failed to fetch logs: ${res.statusText}`)
      process.exit(1)
    }

    const { data } = await res.json() as { data: Array<{ timestamp: string; level: string; message: string }> }

    if (data.length === 0) {
      console.log(`No logs for "${name}" in the last ${opts.since}.`)
      return
    }

    for (const entry of data) {
      const ts = new Date(entry.timestamp).toISOString().slice(11, 23)
      const level = entry.level.toUpperCase().padEnd(5)
      console.log(`${ts} [${level}] ${entry.message}`)
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : "unknown"}`)
    process.exit(1)
  }
}

// ─── Invoke ──────────────────────────────────────────────────────────────────

async function invoke(
  cwd: string,
  name: string,
  opts: { data: string; auth?: boolean; local?: boolean },
): Promise<void> {
  let url: string
  const headers: Record<string, string> = { "Content-Type": "application/json" }

  if (opts.local) {
    url = `http://localhost:54321/functions/v1/${name}`
  } else {
    const { getLinkedProject, getCloudToken } = await loadCloudHelpers()
    const linked = getLinkedProject(cwd)
    if (linked) {
      url = `https://${linked.ref}.supatype.io/functions/v1/${name}`
      const token = getCloudToken()
      if (token && opts.auth) {
        headers["Authorization"] = `Bearer ${token}`
      }
    } else {
      // Default to local
      url = `http://localhost:54321/functions/v1/${name}`
    }
  }

  if (opts.auth && !headers["Authorization"]) {
    // Generate a test JWT for local invocation
    headers["Authorization"] = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImlhdCI6MTcwMDAwMDAwMH0.test"
  }

  try {
    let body: string | undefined
    try {
      JSON.parse(opts.data)
      body = opts.data
    } catch {
      console.error("Invalid JSON data. Use --data '{\"key\": \"value\"}'")
      process.exit(1)
    }

    const start = Date.now()
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    })

    const duration = Date.now() - start
    const responseBody = await res.text()

    console.log(`Status: ${res.status} (${duration}ms)`)
    console.log()

    // Try to pretty-print JSON
    try {
      const json = JSON.parse(responseBody)
      console.log(JSON.stringify(json, null, 2))
    } catch {
      console.log(responseBody)
    }
  } catch (err) {
    if (err instanceof TypeError && (err as Error).message.includes("fetch")) {
      console.error(`Cannot reach ${url}`)
      console.error("Is the function server running? Start it with: npx supatype functions serve")
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : "unknown"}`)
    }
    process.exit(1)
  }
}

// ─── Env management ──────────────────────────────────────────────────────────

async function envList(cwd: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    // Show local env vars
    const envPath = resolve(cwd, FUNCTIONS_DIR, ENV_LOCAL)
    if (!existsSync(envPath)) {
      console.log("No environment variables configured.")
      return
    }

    const lines = readFileSync(envPath, "utf8").split("\n")
    console.log("Local environment variables:\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx)
        console.log(`  ${key} = ••••••••`)
      }
    }
    return
  }

  const token = getCloudToken()
  if (!token) {
    console.error("Not logged in. Run: npx supatype cloud login")
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl()}/api/v1/projects/${linked.ref}/functions/env`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": linked.orgId ?? "",
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      console.error(`Failed to list env vars: ${res.statusText}`)
      process.exit(1)
    }

    const { data } = await res.json() as { data: string[] }

    if (data.length === 0) {
      console.log("No environment variables set.")
      return
    }

    console.log("Environment variables (values masked):\n")
    for (const key of data) {
      console.log(`  ${key} = ••••••••`)
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : "unknown"}`)
    process.exit(1)
  }
}

async function envSet(cwd: string, keyvalue: string): Promise<void> {
  const eqIdx = keyvalue.indexOf("=")
  if (eqIdx <= 0) {
    console.error("Invalid format. Use: npx supatype functions env set KEY=value")
    process.exit(1)
  }

  const key = keyvalue.slice(0, eqIdx)
  const value = keyvalue.slice(eqIdx + 1)

  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    // Set in local env file
    const envPath = resolve(cwd, FUNCTIONS_DIR, ENV_LOCAL)
    let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""

    // Replace existing or append
    const regex = new RegExp(`^${key}=.*$`, "m")
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`)
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`
    }

    writeFileSync(envPath, content, "utf8")
    console.log(`Set ${key} in local env file.`)
    return
  }

  const token = getCloudToken()
  if (!token) {
    console.error("Not logged in. Run: npx supatype cloud login")
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl()}/api/v1/projects/${linked.ref}/functions/env`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Org-Id": linked.orgId ?? "",
      },
      body: JSON.stringify({ key, value }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>
      console.error(`Failed to set env var: ${body["message"] ?? res.statusText}`)
      process.exit(1)
    }

    console.log(`Set ${key} for project ${linked.ref}.`)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : "unknown"}`)
    process.exit(1)
  }
}

async function envUnset(cwd: string, key: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    const envPath = resolve(cwd, FUNCTIONS_DIR, ENV_LOCAL)
    if (!existsSync(envPath)) {
      console.error("No local env file found.")
      process.exit(1)
    }

    let content = readFileSync(envPath, "utf8")
    const regex = new RegExp(`^${key}=.*\n?`, "m")
    content = content.replace(regex, "")
    writeFileSync(envPath, content, "utf8")
    console.log(`Removed ${key} from local env file.`)
    return
  }

  const token = getCloudToken()
  if (!token) {
    console.error("Not logged in. Run: npx supatype cloud login")
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl()}/api/v1/projects/${linked.ref}/functions/env/${key}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": linked.orgId ?? "",
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, string>
      console.error(`Failed to unset env var: ${body["message"] ?? res.statusText}`)
      process.exit(1)
    }

    console.log(`Removed ${key} for project ${linked.ref}.`)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : "unknown"}`)
    process.exit(1)
  }
}

// ─── Cloud helpers (lazy loaded) ─────────────────────────────────────────────

interface CloudHelpers {
  getLinkedProject(cwd: string): { ref: string; orgId?: string } | null
  getCloudToken(): string | null
  getCloudApiUrl(): string
}

async function loadCloudHelpers(): Promise<CloudHelpers> {
  // These helpers read the local .supatype/linked.json and auth token
  return {
    getLinkedProject(cwd: string): { ref: string; orgId?: string } | null {
      const linkedPath = resolve(cwd, ".supatype/linked.json")
      if (!existsSync(linkedPath)) return null
      try {
        const data = JSON.parse(readFileSync(linkedPath, "utf8")) as Record<string, string>
        const ref = data["ref"]
        const orgId = data["orgId"]
        return ref ? { ref, ...(orgId !== undefined ? { orgId } : {}) } : null
      } catch {
        return null
      }
    },

    getCloudToken(): string | null {
      // Check env first, then config file
      if (process.env["SUPATYPE_ACCESS_TOKEN"]) {
        return process.env["SUPATYPE_ACCESS_TOKEN"]
      }
      const tokenPath = resolve(
        process.env["HOME"] ?? process.env["USERPROFILE"] ?? "~",
        ".supatype/token",
      )
      if (!existsSync(tokenPath)) return null
      return readFileSync(tokenPath, "utf8").trim() || null
    },

    getCloudApiUrl(): string {
      return process.env["SUPATYPE_API_URL"] ?? "https://api.supatype.io"
    },
  }
}
