import type { Command } from "commander"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { fetchAllLatestVersions } from "../binary-cache.js"

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

export function registerInit(program: Command): void {
  program
    .command("init [name]")
    .description("Scaffold a new Supatype project")
    .option(
      "--mode <mode>",
      "Server mode in supatype.config.ts: dev (default) | standalone (native ACME — not Compose self-host)",
      "dev",
    )
    .action(async (name?: string, opts: { mode: string } = { mode: "dev" }) => {
      const projectName = name ?? "my-project"
      const dir = name ? resolve(process.cwd(), name) : process.cwd()

      if (name && existsSync(dir)) {
        console.error(`Directory already exists: ${dir}`)
        process.exit(1)
      }

      if (name) mkdirSync(dir, { recursive: true })

      let versions: Record<string, string> = {}
      try {
        console.log("Fetching latest component versions from CDN...")
        versions = await fetchAllLatestVersions()
      } catch {
        // Non-fatal: scaffold with placeholder versions; user can run `supatype update`.
      }

      scaffold(dir, projectName, opts.mode as "dev" | "standalone", versions)

      console.log(`\nSupatype project ready${name ? ` in ${name}/` : ""}.\n`)
      console.log("Next steps:")
      if (name) console.log(`  cd ${name}`)
      console.log("  npm install")
      console.log("  supatype keys")
      console.log("  supatype dev          # native Postgres + supatype-server")
      console.log("  supatype push         # apply schema + generate types")
      console.log("\nStatic frontend (self-host):")
      console.log("  supatype app add --static ./public")
      console.log("  npm run build         # write files into public/")
      console.log("  supatype self-host compose up -d")
      if (opts.mode === "standalone") {
        console.log("\nStandalone (native TLS with ACME):")
        console.log("  Edit supatype.config.ts — set server.domain")
        console.log("  supatype dev          # or run supatype-server with your TLS setup")
      }
      console.log()
    })
}

function scaffold(dir: string, projectName: string, mode: "dev" | "standalone" = "dev", versions: Record<string, string> = {}): void {
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    mkdirSync(resolve(full, ".."), { recursive: true })
    writeFileSync(full, content, "utf8")
    console.log(`  created  ${rel}`)
  }

  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) {
    write("package.json", packageJsonTemplate(projectName, cliPackageVersion()))
  } else {
    console.log("  skipped  package.json (already exists)")
  }

  write("supatype.config.ts", tsConfigTemplate(projectName, mode, versions))
  write("schema/index.ts", schemaTemplate())
  write(".env", envTemplate(projectName))
  write("seed.ts", seedTemplate(projectName))
  write("seeds/.gitkeep", "")
  write("public/.gitkeep", "")
  write(".gitignore", gitignoreTemplate())
}

// ─── Templates ───────────────────────────────────────────────────────────────

function packageJsonTemplate(projectName: string, cliVersion: string): string {
  return `{
  "name": "${projectName}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "supatype dev",
    "push": "supatype push",
    "seed": "tsx seed.ts"
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

function tsConfigTemplate(projectName: string, mode: "dev" | "standalone", versions: Record<string, string> = {}): string {
  const domainField =
    mode === "standalone"
      ? `    domain: "",  // e.g. "api.example.com" for ACME TLS\n`
      : ""
  const v = (key: string, fallback: string) => versions[key] ?? fallback
  return `import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "${projectName}" },
  database: {
    provider: "native",
    // provider: "docker", image: "supatype/postgres:17-latest"  // full extensions stack via Docker
  },
  server: {
    mode: "${mode}",
    port: 54321,
${domainField}  },
  app: {
    mode: "none",
    // mode: "static", static_dir: "./public",  // supatype app add --static ./public
    // mode: "proxy", upstream: "http://localhost:3000",
    // vite_dev_url: "http://127.0.0.1:5173",  // dev HMR at /_vite (when using a separate Vite server)
  },
  versions: {
    engine: "${v("engine", "latest")}",
    server: "${v("server", "latest")}",
    postgres: "${v("postgres", "latest")}",
    deno: "${v("deno", "latest")}",
  },
  email: { provider: "console" },
  storage: { provider: "local", local_path: ".supatype/storage" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  // Self-host production: supatype self-host compose (Docker only). Standalone + domain = native ACME dev.
})
`
}

function schemaTemplate(): string {
  return `import type { Model, Public, Owner, Role, SupatypeAuthUserId, Unique, Email } from "@supatype/types"

export type User = Model<{
  id: SupatypeAuthUserId
  email: Unique<Email>
  name: string
  created_at: string
  updated_at: string
}, {
  access: {
    read: Public
    create: Public
    update: Owner<"id">
    delete: Role<"admin">
  }
}>
`
}

function envTemplate(projectName: string): string {
  return `DATABASE_URL=postgresql://supatype_admin:postgres@localhost:5432/${projectName}
POSTGRES_USER=supatype_admin
POSTGRES_PASSWORD=postgres
POSTGRES_DB=${projectName}

# JWT — run \`supatype keys\` to generate ANON_KEY and SERVICE_ROLE_KEY
JWT_SECRET=super-secret-jwt-token-change-in-production
ANON_KEY=
SERVICE_ROLE_KEY=

# Site URL (used by GoTrue for email redirects)
SITE_URL=http://localhost:3000

# SMTP — leave empty to use email autoconfirm in dev (no emails sent)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_SENDER_NAME=${projectName}

# Storage (MinIO for local dev)
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=supatype
S3_SECRET_KEY=supatype-secret

# Self-host compose uses the same DATABASE_URL when Postgres is published on localhost:5432
`
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
  // await db\`INSERT INTO users (email, name) VALUES ('admin@example.com', 'Admin')\`

  await db.end()
  console.log("Done.")
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
`
}

function gitignoreTemplate(): string {
  return `.env
node_modules/
dist/
.supatype/engine/
# Local overrides — never commit
supatype.local.config.ts
supatype.local.config.js
supatype.local.config.mjs
# Generated by supatype push
src/types/supatype.d.ts
src/lib/supatype.ts
`
}
