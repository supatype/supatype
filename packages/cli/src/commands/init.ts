import type { Command } from "commander"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

export { scaffold }

// ─── Markers used by `supatype app add / remove` (app.ts) ────────────────────
export const APP_COMPOSE_MARKER = "  # ─── App service (run: supatype app add) ───"
export const KONG_APP_MARKER = "  # ─── App fallback route (run: supatype app add) ───"

export function registerInit(program: Command): void {
  program
    .command("init [name]")
    .description("Scaffold a new Supatype project")
    .option("--mode <mode>", "Server mode: dev (default) | standalone (ACME TLS)", "dev")
    .action((name?: string, opts: { mode: string } = { mode: "dev" }) => {
      const projectName = name ?? "my-project"
      const dir = name ? resolve(process.cwd(), name) : process.cwd()

      if (name && existsSync(dir)) {
        console.error(`Directory already exists: ${dir}`)
        process.exit(1)
      }

      if (name) mkdirSync(dir, { recursive: true })

      scaffold(dir, projectName, opts.mode as "dev" | "standalone")

      console.log(`\nSupatype project ready${name ? ` in ${name}/` : ""}.\n`)
      console.log("Next steps:")
      if (name) console.log(`  cd ${name}`)
      console.log("  pnpm install")
      console.log("  supatype dev        # start local Postgres + supatype-server")
      console.log("  supatype push       # apply schema + generate types")
      if (opts.mode === "standalone") {
        console.log("\nFor standalone (ACME TLS):")
        console.log("  Edit supatype.config.toml and set [server] domain")
        console.log("  supatype install-service   # install systemd units")
      }
      console.log()
    })
}

function scaffold(dir: string, projectName: string, mode: "dev" | "standalone" = "dev"): void {
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    mkdirSync(resolve(full, ".."), { recursive: true })
    writeFileSync(full, content, "utf8")
    console.log(`  created  ${rel}`)
  }

  write("supatype.config.toml", tomlConfigTemplate(projectName, mode))
  write("schema/index.ts", schemaTemplate())
  write(".env", envTemplate(projectName))
  write("seed.ts", seedTemplate(projectName))
  write(".gitignore", gitignoreTemplate())
}

// ─── Templates ───────────────────────────────────────────────────────────────

function tomlConfigTemplate(projectName: string, mode: "dev" | "standalone"): string {
  const standaloneExtras = mode === "standalone"
    ? `\ndomain = ""  # Set your domain for ACME TLS (e.g. "api.example.com")\n`
    : ""
  return `[project]
name = "${projectName}"

[database]
provider = "docker"
# image = "supatype/postgres:17-latest"  # override in supatype.local.config.toml for local builds

[server]
mode = "${mode}"
port = 54321${standaloneExtras}
[app]
mode = "none"
# mode = "static"
# static_dir = "./dist"
# mode = "proxy"
# upstream = "http://localhost:3000"

[versions]
engine   = "0.4.2"
server   = "0.1.0"
postgres = "17.2"
deno     = "2.2.0"

# Local binary overrides belong in supatype.local.config.toml (gitignored):
# [overrides]
# engine = "/path/to/local/supatype-engine"
# server = "/path/to/local/supatype-server"
# postgres_dir = "/path/to/local/pg"

[email]
provider = "console"  # console | smtp | resend | ses

[storage]
provider = "local"
local_path = ".supatype/storage"

[schema]
path = "schema/index.ts"
pg_schema = "public"
`
}

function schemaTemplate(): string {
  return `import { model, field, access } from "@supatype/schema"

export const User = model("user", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    email: field.email({ required: true, unique: true }),
    name: field.text({ required: true }),
  },
  access: {
    read: access.public(),
    create: access.public(),
    update: access.owner("id"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})
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
# Local binary overrides — never commit
supatype.local.config.toml
# Generated by supatype push
src/types/supatype.d.ts
src/lib/supatype.ts
`
}
