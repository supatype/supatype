import type { Command } from "commander"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import * as p from "@clack/prompts"
import { ensureNotCancelled, printLogo } from "../prompts.js"
import { generateAndWriteKeys } from "./keys.js"

export { scaffold }

// ─── Markers used by `supatype app add / remove` (app.ts) ────────────────────
export const APP_COMPOSE_MARKER = "  # ─── App service (run: supatype app add) ───"
export const KONG_APP_MARKER = "  # ─── App fallback route (run: supatype app add) ───"

const CLI_PACKAGE_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
)

function cliPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(CLI_PACKAGE_JSON, "utf8")) as { version?: string }
    return pkg.version ?? "0.1.0"
  } catch {
    return "0.1.0"
  }
}

// ─── Options model ─────────────────────────────────────────────────────────--

type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

/** Where the project runs in production (drives committed config + local override). */
type ProductionTarget = "cloud" | "self-host" | "later"

export interface ScaffoldAppOptions {
  mode: "none" | "static" | "proxy"
  staticDir?: string
  upstream?: string
  start?: string
  viteDevUrl?: string
}

/** File-affecting answers that drive what `scaffold()` writes. */
export interface ScaffoldOptions {
  projectName: string
  /** Local development runtime (docker recommended). */
  provider: "docker" | "native"
  productionTarget: ProductionTarget
  domain?: string
  /** ACME contact email for Let's Encrypt HTTPS (self-host + domain). */
  tlsEmail?: string
  schemaPath: string
  app: ScaffoldAppOptions
  email: "console" | "smtp" | "resend" | "ses"
  /** Object storage while developing locally (`supatype dev`). */
  storageLocal: "local" | "s3"
  /** Object storage when deployed to production. */
  storageProduction: "local" | "s3"
  helloFunction: boolean
}

type StorageProvider = ScaffoldOptions["storageLocal"]

const STORAGE_PROVIDER_OPTIONS: {
  value: StorageProvider
  label: string
  hint: string
}[] = [
  { value: "local", label: "Local", hint: "storage you host yourself (MinIO)" },
  { value: "s3", label: "S3", hint: "external bucket (AWS S3 or compatible)" },
]

/** Wizard result = scaffold options plus runtime actions (install / keys). */
interface WizardResult extends ScaffoldOptions {
  packageManager: PackageManager
  install: boolean
  generateKeys: boolean
}

/** `--mode dev|standalone` is mapped onto a production target for back-compat. */
function productionTargetFromMode(mode: string): ProductionTarget {
  return mode === "standalone" ? "self-host" : "later"
}

/** supatype-server mode written to the committed config for a production target. */
function serverModeForTarget(target: ProductionTarget): "dev" | "standalone" | "managed" {
  switch (target) {
    case "cloud":
      return "managed"
    case "self-host":
      return "standalone"
    case "later":
      return "dev"
  }
}

export function defaultScaffoldOptions(
  projectName: string,
  productionTarget: ProductionTarget = "later",
): ScaffoldOptions {
  return {
    projectName,
    provider: "docker",
    productionTarget,
    ...(productionTarget === "self-host" ? { domain: "" } : {}),
    schemaPath: "schema/index.ts",
    app: { mode: "none" },
    email: "console",
    storageLocal: "local",
    storageProduction: "local",
    helloFunction: false,
  }
}

// ─── Registration ──────────────────────────────────────────────────────────--

interface InitCliOptions {
  mode: string
  defaults?: boolean
  install: boolean
  keys: boolean
}

export function registerInit(program: Command): void {
  program
    .command("init [name]")
    .description("Scaffold a new Supatype project")
    .option(
      "--mode <mode>",
      "Back-compat: dev (default, local only) | standalone (self-host production target)",
      "dev",
    )
    .option("-y, --defaults", "Skip all prompts and use sensible defaults")
    .option("--no-install", "Do not run the package manager install step")
    .option("--no-keys", "Do not generate ANON_KEY / SERVICE_ROLE_KEY")
    .action(async (name: string | undefined, opts: InitCliOptions) => {
      const dir = name ? resolve(process.cwd(), name) : process.cwd()

      if (name && existsSync(dir)) {
        console.error(`Directory already exists: ${dir}`)
        process.exit(1)
      }

      const defaultName = name ?? basename(dir) ?? "my-project"
      const interactive = !opts.defaults && Boolean(process.stdin.isTTY)

      const modeTarget = productionTargetFromMode(opts.mode)

      let result: WizardResult
      if (interactive) {
        printLogo()
        result = await runWizard(defaultName, modeTarget)
      } else {
        result = {
          ...defaultScaffoldOptions(defaultName, modeTarget),
          packageManager: detectInvokingPackageManager(),
          install: true,
          generateKeys: true,
        }
      }

      // CLI flags override wizard / default action choices.
      const doInstall = opts.install !== false && result.install
      const doKeys = opts.keys !== false && result.generateKeys

      if (name) mkdirSync(dir, { recursive: true })

      scaffold(dir, result)

      if (doInstall) runInstall(dir, result.packageManager)
      const keysGenerated = doKeys ? writeKeys(dir) : false

      printNextSteps({
        name,
        result,
        installed: doInstall,
        keysGenerated,
      })
    })
}

// ─── Wizard ──────────────────────────────────────────────────────────────────

async function runWizard(
  defaultName: string,
  defaultTarget: ProductionTarget,
): Promise<WizardResult> {
  p.intro("Create a new Supatype project")

  const projectName = ensureNotCancelled(
    await p.text({
      message: "Project name",
      defaultValue: defaultName,
      placeholder: defaultName,
    }),
  ).trim() || defaultName

  const packageManager = ensureNotCancelled(
    await p.select<PackageManager>({
      message: "Package manager",
      initialValue: detectInvokingPackageManager(),
      options: [
        { value: "npm", label: "npm" },
        { value: "pnpm", label: "pnpm" },
        { value: "yarn", label: "yarn" },
        { value: "bun", label: "bun" },
      ],
    }),
  )

  const productionTarget = ensureNotCancelled(
    await p.select<ProductionTarget>({
      message: "Where will this run in production?",
      initialValue: defaultTarget,
      options: [
        { value: "cloud", label: "Supatype Cloud", hint: "managed; deploy via supatype link" },
        { value: "self-host", label: "Self-host", hint: "your own server with TLS" },
        { value: "later", label: "Decide later", hint: "local development only for now" },
      ],
    }),
  )

  let domain: string | undefined
  let tlsEmail: string | undefined
  if (productionTarget === "self-host") {
    domain = ensureNotCancelled(
      await p.text({
        message: "Production domain for ACME TLS (optional, can set later)",
        placeholder: "api.example.com",
        defaultValue: "",
      }),
    ).trim()
    if (domain) {
      tlsEmail =
        ensureNotCancelled(
          await p.text({
            message: "Email for Let's Encrypt (HTTPS) certificates",
            placeholder: "you@example.com",
            defaultValue: "",
          }),
        ).trim() || undefined
    }
  }

  const provider = ensureNotCancelled(
    await p.select<ScaffoldOptions["provider"]>({
      message: "How should Postgres and the server run for local development?",
      initialValue: "docker",
      options: [
        { value: "docker", label: "Docker", hint: "Docker Compose stack (recommended)" },
        { value: "native", label: "Native", hint: "host Postgres + server binaries, no Docker" },
      ],
    }),
  )

  const schemaPath = ensureNotCancelled(
    await p.text({
      message: "Where should your schema live?",
      defaultValue: "schema/index.ts",
      placeholder: "schema/index.ts",
    }),
  ).trim() || "schema/index.ts"

  const app = await promptApp()

  const email = ensureNotCancelled(
    await p.select<ScaffoldOptions["email"]>({
      message: "Email provider",
      initialValue: "console",
      options: [
        { value: "console", label: "console", hint: "log emails to the terminal (dev)" },
        { value: "smtp", label: "SMTP" },
        { value: "resend", label: "Resend" },
        { value: "ses", label: "Amazon SES" },
      ],
    }),
  )

  const storageLocal = ensureNotCancelled(
    await p.select<StorageProvider>({
      message: "Local storage (for development)?",
      initialValue: "local",
      options: STORAGE_PROVIDER_OPTIONS,
    }),
  )

  const storageProduction = ensureNotCancelled(
    await p.select<StorageProvider>({
      message: "Production storage?",
      initialValue: "local",
      options: STORAGE_PROVIDER_OPTIONS,
    }),
  )

  const helloFunction = ensureNotCancelled(
    await p.confirm({
      message: "Create a hello-world edge function?",
      initialValue: false,
    }),
  )

  const install = ensureNotCancelled(
    await p.confirm({
      message: `Install dependencies with ${packageManager} now?`,
      initialValue: true,
    }),
  )

  const generateKeys = ensureNotCancelled(
    await p.confirm({
      message: "Generate ANON_KEY and SERVICE_ROLE_KEY now?",
      initialValue: true,
    }),
  )

  p.outro("Setting up your project...")

  return {
    projectName,
    provider,
    productionTarget,
    ...(domain !== undefined ? { domain } : {}),
    ...(tlsEmail !== undefined ? { tlsEmail } : {}),
    schemaPath,
    app,
    email,
    storageLocal,
    storageProduction,
    helloFunction,
    packageManager,
    install,
    generateKeys,
  }
}

async function promptApp(): Promise<ScaffoldAppOptions> {
  const mode = ensureNotCancelled(
    await p.select<ScaffoldAppOptions["mode"]>({
      message: "Host a frontend app at /?",
      initialValue: "none",
      options: [
        { value: "none", label: "No app", hint: "API only" },
        { value: "static", label: "Static site", hint: "serve a built directory" },
        { value: "proxy", label: "Local dev server", hint: "forward requests to a dev server you run" },
      ],
    }),
  )

  if (mode === "static") {
    const staticDir = ensureNotCancelled(
      await p.text({
        message: "Directory to serve",
        defaultValue: "./public",
        placeholder: "./public",
      }),
    ).trim() || "./public"
    const viteDevUrl = await promptViteDevUrl()
    return { mode, staticDir, ...(viteDevUrl ? { viteDevUrl } : {}) }
  }

  if (mode === "proxy") {
    const upstream = ensureNotCancelled(
      await p.text({
        message: "URL of your running dev server",
        defaultValue: "http://localhost:3000",
        placeholder: "http://localhost:3000",
      }),
    ).trim() || "http://localhost:3000"
    const start = ensureNotCancelled(
      await p.text({
        message: "package.json script that starts your dev server",
        defaultValue: "dev",
        placeholder: "dev",
      }),
    ).trim() || "dev"
    const viteDevUrl = await promptViteDevUrl()
    return { mode, upstream, start, ...(viteDevUrl ? { viteDevUrl } : {}) }
  }

  return { mode: "none" }
}

async function promptViteDevUrl(): Promise<string | undefined> {
  const useVite = ensureNotCancelled(
    await p.confirm({
      message: "Enable live reload from a separate Vite dev server?",
      initialValue: false,
    }),
  )
  if (!useVite) return undefined
  return (
    ensureNotCancelled(
      await p.text({
        message: "Vite dev server URL",
        defaultValue: "http://127.0.0.1:5173",
        placeholder: "http://127.0.0.1:5173",
      }),
    ).trim() || "http://127.0.0.1:5173"
  )
}

// ─── Package manager ───────────────────────────────────────────────────────--

function detectInvokingPackageManager(): PackageManager {
  const ua = process.env["npm_config_user_agent"] ?? ""
  if (ua.startsWith("pnpm")) return "pnpm"
  if (ua.startsWith("yarn")) return "yarn"
  if (ua.startsWith("bun")) return "bun"
  return "npm"
}

function runInstall(dir: string, pm: PackageManager): void {
  console.log(`\nInstalling dependencies with ${pm}...`)
  const res = spawnSync(pm, ["install"], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  if (res.status !== 0 || res.error) {
    console.warn(
      `\n[supatype] Dependency install did not complete (run "${pm} install" manually).`,
    )
  }
}

function writeKeys(dir: string): boolean {
  const keys = generateAndWriteKeys(dir)
  if (!keys) {
    console.warn(
      "\n[supatype] Could not generate keys (JWT_SECRET missing). Run `supatype keys` manually.",
    )
    return false
  }
  return true
}

// ─── Scaffold ──────────────────────────────────────────────────────────────--

function scaffold(dir: string, optsOrName: ScaffoldOptions | string): void {
  const opts =
    typeof optsOrName === "string" ? defaultScaffoldOptions(optsOrName) : optsOrName
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    mkdirSync(resolve(full, ".."), { recursive: true })
    writeFileSync(full, content, "utf8")
    console.log(`  created  ${rel}`)
  }

  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) {
    write("package.json", packageJsonTemplate(opts, cliPackageVersion()))
  } else {
    console.log("  skipped  package.json (already exists)")
  }

  write("supatype.config.ts", tsConfigTemplate(opts))
  if (opts.productionTarget !== "later") {
    write("supatype.local.config.ts", localConfigTemplate())
  }
  write(opts.schemaPath, schemaTemplate())
  write(".env", envTemplate(opts))
  write("seed.ts", seedTemplate(opts.projectName))
  write("seeds/.gitkeep", "")
  if (opts.app.mode === "static") {
    const staticRel = staticDirRelative(opts.app.staticDir)
    write(`${staticRel}/.gitkeep`, "")
  } else {
    write("public/.gitkeep", "")
  }

  if (opts.helloFunction) scaffoldHelloFunction(dir, write)

  const gitignorePath = join(dir, ".gitignore")
  if (existsSync(gitignorePath)) {
    const merged = mergeGitignoreTemplate(readFileSync(gitignorePath, "utf8"))
    if (merged !== readFileSync(gitignorePath, "utf8")) {
      writeFileSync(gitignorePath, merged, "utf8")
      console.log("  updated  .gitignore (added .supatype/)")
    } else {
      console.log("  skipped  .gitignore (already exists)")
    }
  } else {
    write(".gitignore", gitignoreTemplate())
  }
}

function staticDirRelative(staticDir?: string): string {
  const raw = (staticDir ?? "./public").trim()
  return raw.replace(/^\.\//, "").replace(/\/+$/, "") || "public"
}

function scaffoldHelloFunction(
  dir: string,
  write: (rel: string, content: string) => void,
): void {
  write("functions/hello/index.ts", helloFunctionTemplate())
  if (!existsSync(join(dir, "functions/_shared/README.md"))) {
    write("functions/_shared/README.md", sharedFunctionsReadme())
  }
  if (!existsSync(join(dir, "functions/.env.local"))) {
    write("functions/.env.local", functionsEnvLocalTemplate())
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

function packageJsonTemplate(opts: ScaffoldOptions, cliVersion: string): string {
  const scripts: string[] = [
    `    "dev": "supatype dev"`,
    `    "push": "supatype push"`,
    `    "seed": "tsx seed.ts"`,
  ]
  if (opts.helloFunction) {
    scripts.push(`    "functions": "supatype functions serve"`)
  }
  return `{
  "name": "${opts.projectName}",
  "private": true,
  "type": "module",
  "scripts": {
${scripts.join(",\n")}
  },
  "dependencies": {
    "@supatype/cli": "^${cliVersion}",
    "@supatype/types": "^${cliVersion}"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5"
  }
}
`
}

function tsConfigTemplate(opts: ScaffoldOptions): string {
  const serverMode = serverModeForTarget(opts.productionTarget)
  const hasLocalOverride = opts.productionTarget !== "later"
  const lines: string[] = []
  lines.push(`import { defineConfig } from "@supatype/cli"`)
  lines.push("")
  if (hasLocalOverride) {
    lines.push(`// Committed config = ${opts.productionTarget} production target.`)
    lines.push(`// Local development overrides live in supatype.local.config.ts (gitignored).`)
  }
  lines.push(`export default defineConfig({`)
  lines.push(`  project: { name: "${opts.projectName}" },`)
  lines.push(`  provider: "${opts.provider}",`)
  if (opts.provider === "docker") {
    lines.push(`  // provider: "native"  // host Postgres + supatype-server binaries (no Docker)`)
  }
  lines.push(`  database: {`)
  lines.push(`    provider: "${opts.provider}",`)
  lines.push(`  },`)
  lines.push(`  server: {`)
  lines.push(`    mode: "${serverMode}",`)
  lines.push(`    port: 54321,`)
  if (serverMode === "standalone") {
    lines.push(`    domain: "${opts.domain ?? ""}",  // e.g. "api.example.com" for ACME TLS`)
    if (opts.tlsEmail) {
      lines.push(`    tls: { email: "${opts.tlsEmail}" },  // automatic HTTPS via Let's Encrypt`)
    } else {
      lines.push(`    // tls: { email: "you@example.com" },  // set to enable automatic HTTPS (Let's Encrypt)`)
    }
  }
  lines.push(`  },`)
  lines.push(...appConfigLines(opts.app))
  if (opts.productionTarget !== "later") {
    lines.push(`  environments: { default: "production" },  // supatype link --env production ...`)
  }
  lines.push(
    `  // Optional: pin component versions (native cache + Docker images synced to .env on dev/push)`,
  )
  lines.push(`  // versions: { engine: "0.1.2", server: "1.0.5", postgres: "17.2", deno: "2.2.0" },`)
  lines.push(`  email: { provider: "${opts.email}" },`)
  lines.push(...storageConfigLines(opts.storageLocal, opts.storageProduction))
  lines.push(`  schema: { path: "${opts.schemaPath}", pg_schema: "public" },`)
  lines.push(
    `  // Self-host production: supatype self-host compose (Docker only). Standalone + domain = native ACME dev.`,
  )
  lines.push(`})`)
  return lines.join("\n") + "\n"
}

function localConfigTemplate(): string {
  return `import type { SupatypeConfig } from "@supatype/cli"

// Local development overrides — gitignored, deep-merged over supatype.config.ts.
// Keeps \`supatype dev\` in local mode while the committed config targets production.
const localConfig: Partial<SupatypeConfig> = {
  server: { mode: "dev" },
}

export default localConfig
`
}

function appConfigLines(app: ScaffoldAppOptions): string[] {
  if (app.mode === "static") {
    const out = [
      `  app: {`,
      `    mode: "static",`,
      `    static_dir: "${app.staticDir ?? "./public"}",`,
    ]
    if (app.viteDevUrl) out.push(`    vite_dev_url: "${app.viteDevUrl}",`)
    out.push(`  },`)
    return out
  }
  if (app.mode === "proxy") {
    const out = [
      `  app: {`,
      `    mode: "proxy",`,
      `    upstream: "${app.upstream ?? "http://localhost:3000"}",`,
      `    start: "${app.start ?? "dev"}",`,
    ]
    if (app.viteDevUrl) out.push(`    vite_dev_url: "${app.viteDevUrl}",`)
    out.push(`  },`)
    return out
  }
  return [
    `  app: {`,
    `    mode: "none",`,
    `    // mode: "static", static_dir: "./public",  // supatype app add --static ./public`,
    `    // mode: "proxy", upstream: "http://localhost:3000", start: "dev",`,
    `    // vite_dev_url: "http://127.0.0.1:5173",  // live reload from a separate Vite dev server`,
    `  },`,
  ]
}

function storageConfigLines(
  storageLocal: StorageProvider,
  storageProduction: StorageProvider,
): string[] {
  const lines: string[] = []
  if (storageLocal === "s3") {
    lines.push(`  storage: { provider: "s3" },  // dev — configure S3_* in .env`)
  } else {
    lines.push(`  storage: { provider: "local", local_path: ".supatype/storage" },`)
  }
  if (storageProduction === "s3" && storageLocal !== "s3") {
    lines.push(`  // Production storage: external S3 bucket — set production S3_* in .env`)
  } else if (storageProduction === "local" && storageLocal === "s3") {
    lines.push(`  // Production storage: MinIO on your server (included in self-host compose)`)
  }
  return lines
}

function schemaTemplate(): string {
  return `import type { Model, LoggedIn, Owner, Public, Role, SupatypeAuthUserId, UUID } from "@supatype/types"

/** App profile for a signed-in user. \`id\` matches the Supatype auth user id. */
export type Profile = Model<{
  id: SupatypeAuthUserId
  display_name: string
}, {
  access: {
    read: LoggedIn
    create: Owner<"id">
    update: Owner<"id">
    delete: Owner<"id">
  }
}>

/** Example singleton global — editable in Studio under Settings. */
export type SiteSettings = Model<{
  id: UUID
  site_name: string
}, {
  singleton: true
  access: {
    read: Public
    update: Role<"admin">
  }
}>
`
}

function envTemplate(opts: ScaffoldOptions): string {
  const sections: string[] = []
  sections.push(`DATABASE_URL=postgresql://supatype_admin:postgres@localhost:5432/${opts.projectName}
POSTGRES_USER=supatype_admin
POSTGRES_PASSWORD=postgres
POSTGRES_DB=${opts.projectName}`)

  sections.push(`# JWT — run \`supatype keys\` to generate ANON_KEY and SERVICE_ROLE_KEY
JWT_SECRET=super-secret-jwt-token-change-in-production
ANON_KEY=
SERVICE_ROLE_KEY=`)

  sections.push(`# Site URL (used by GoTrue for email redirects)
SITE_URL=http://localhost:3000`)

  sections.push(emailEnvSection(opts.email, opts.projectName))
  sections.push(storageEnvSections(opts.storageLocal, opts.storageProduction))

  sections.push(
    `# Self-host compose uses the same DATABASE_URL when Postgres is published on localhost:5432`,
  )

  return sections.join("\n\n") + "\n"
}

function emailEnvSection(email: ScaffoldOptions["email"], projectName: string): string {
  switch (email) {
    case "resend":
      return `# Email (Resend)
RESEND_API_KEY=
RESEND_FROM=onboarding@resend.dev`
    case "ses":
      return `# Email (Amazon SES)
SES_FROM=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=`
    case "smtp":
      return `# Email (SMTP)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SENDER_NAME=${projectName}`
    case "console":
    default:
      return `# SMTP — leave empty to use email autoconfirm in dev (no emails sent)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_SENDER_NAME=${projectName}`
  }
}

function storageEnvSections(
  storageLocal: StorageProvider,
  storageProduction: StorageProvider,
): string {
  if (storageLocal === storageProduction) {
    if (storageLocal === "s3") {
      return `# Storage (local development and production — external bucket)
# Use separate buckets for dev and production in your provider.
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
    }
    return `${localStorageEnvSection("local")}

# Production storage (MinIO on your server)
# Included in the self-host compose stack — no extra configuration needed.`
  }

  return [localStorageEnvSection(storageLocal), productionStorageEnvSection(storageProduction)].join(
    "\n\n",
  )
}

function localStorageEnvSection(storage: StorageProvider): string {
  if (storage === "s3") {
    return `# Storage (local development — external bucket)
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
  }
  return `# Storage (local development — MinIO)
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=supatype
S3_SECRET_KEY=supatype-secret`
}

function productionStorageEnvSection(storage: StorageProvider): string {
  if (storage === "s3") {
    return `# Storage (production — external bucket)
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=`
  }
  return `# Storage (production — MinIO on your server)
# Included in the self-host compose stack — no extra configuration needed.`
}

function seedTemplate(projectName: string): string {
  return `import { sql } from "@supatype/cli/seed"

// Connect using DATABASE_URL from environment
const db = sql(
  process.env["DATABASE_URL"] ??
    "postgresql://supatype_admin:postgres@localhost:5432/${projectName}",
)

async function seed() {
  console.log("Seeding ${projectName}...")

  // TODO: insert seed data
  // await db\`INSERT INTO profile (id, display_name) VALUES ('...', 'Admin')\`

  await db.end()
  console.log("Done.")
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
`
}

function helloFunctionTemplate(): string {
  return `// hello — Supatype Edge Function
// Docs: https://supatype.com/docs/edge-functions

export default async function handler(req: Request): Promise<Response> {
  const { method } = req

  if (method === "POST") {
    const body = await req.json()
    return new Response(JSON.stringify({ message: "Hello from hello!", received: body }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify({ message: "Hello from hello!" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
`
}

function sharedFunctionsReadme(): string {
  return "# Shared Code\n\nFiles in `_shared/` are available to all functions via relative imports.\nThis directory is not deployed as a function.\n\nExample: `import { sendEmail } from '../_shared/email.ts'`\n"
}

function functionsEnvLocalTemplate(): string {
  return "# Local environment variables for edge functions\n# These are NOT committed to git\n# Set production env vars via: npx supatype functions env set KEY=value\n"
}

function gitignoreTemplate(): string {
  return `.env
node_modules/
dist/
.supatype/
supatype.local.config.ts
supatype.local.config.js
supatype.local.config.mjs
# Generated by supatype push (legacy paths — prefer output.types in config)
src/types/supatype.d.ts
src/lib/supatype.ts
`
}

export function mergeGitignoreTemplate(existingContent: string): string {
  if (existingContent.includes(".supatype/") || existingContent.includes(".supatype\n")) {
    return existingContent
  }
  const block = `
# Supatype — local runtime (contains secrets in link.json)
.supatype/
`
  return existingContent.endsWith("\n") ? `${existingContent}${block}` : `${existingContent}\n${block}`
}

// ─── Next steps ────────────────────────────────────────────────────────────--

function printNextSteps(args: {
  name: string | undefined
  result: WizardResult
  installed: boolean
  keysGenerated: boolean
}): void {
  const { name, result, installed, keysGenerated } = args
  console.log(`\nSupatype project ready${name ? ` in ${name}/` : ""}.\n`)
  console.log("Next steps:")
  if (name) console.log(`  cd ${name}`)
  if (!installed) console.log(`  ${result.packageManager} install`)
  if (!keysGenerated) console.log("  supatype keys")
  console.log("  supatype dev          # Docker Compose stack (Kong :18473)")
  console.log("  supatype push         # apply schema + generate types")
  if (result.helloFunction) {
    console.log("  supatype functions serve   # run edge functions locally")
  }

  if (result.app.mode === "none") {
    console.log("\nStatic frontend (self-host):")
    console.log("  supatype app add --static ./public")
    console.log("  npm run build         # write files into public/")
    console.log("  supatype self-host compose up -d")
  }

  if (result.productionTarget === "cloud") {
    console.log("\nDeploy to Supatype Cloud:")
    console.log("  supatype login")
    console.log("  supatype link --env production --project <ref>")
    console.log("  supatype push --env production")
    console.log("\nsupatype.local.config.ts keeps `supatype dev` local while the committed config targets cloud.")
  } else if (result.productionTarget === "self-host") {
    console.log("\nSelf-host production (your own server):")
    const domain = result.domain?.trim()
    if (domain) {
      console.log(`  1. Point DNS: an A record for ${domain} -> your server's public IP`)
      console.log("  2. Open ports 80 and 443 on the server firewall")
      if (!result.tlsEmail) {
        console.log("  3. Set server.tls.email in supatype.config.ts (required for HTTPS)")
      }
      console.log("  supatype self-host compose up -d   # Kong provisions HTTPS automatically")
      console.log(`  Your Supatype platform goes live at https://${domain}`)
      console.log("  Your app, REST, Auth, Storage, Realtime, Functions, and Studio — all behind one HTTPS domain (certs persist in valkey-data)")
    } else {
      console.log("  Set server.domain + server.tls.email in supatype.config.ts to enable automatic HTTPS")
      console.log("  supatype self-host compose up -d   # Docker stack")
    }
    console.log("  supatype link --env production ... # then: supatype push --env production")
    console.log("\nsupatype.local.config.ts keeps `supatype dev` local while the committed config targets self-host.")
  }
  console.log()
}
