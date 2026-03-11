import type { Command } from "commander"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

export { scaffold }

// ─── Markers used by `supatype app add / remove` ─────────────────────────────
export const APP_COMPOSE_MARKER = "  # ─── App service (run: supatype app add) ───"
export const KONG_APP_MARKER = "  # ─── App fallback route (run: supatype app add) ───"

export function registerInit(program: Command): void {
  program
    .command("init [name]")
    .description("Scaffold a new Supatype project")
    .action((name?: string) => {
      const projectName = name ?? "my-project"
      const dir = name ? resolve(process.cwd(), name) : process.cwd()

      if (name && existsSync(dir)) {
        console.error(`Directory already exists: ${dir}`)
        process.exit(1)
      }

      if (name) mkdirSync(dir, { recursive: true })

      scaffold(dir, projectName)

      console.log(`\nSupatype project ready${name ? ` in ${name}/` : ""}.\n`)
      console.log("Next steps:")
      if (name) console.log(`  cd ${name}`)
      console.log("  pnpm install")
      console.log("  supatype keys       # generate ANON_KEY + SERVICE_ROLE_KEY, add to .env")
      console.log("  supatype dev        # start local Postgres + PgBouncer + GoTrue + PostgREST")
      console.log("  supatype push       # apply schema + generate types\n")
    })
}

function scaffold(dir: string, projectName: string): void {
  const write = (rel: string, content: string) => {
    const full = join(dir, rel)
    mkdirSync(resolve(full, ".."), { recursive: true })
    writeFileSync(full, content, "utf8")
    console.log(`  created  ${rel}`)
  }

  write("supatype.config.ts", configTemplate(projectName))
  write("schema/index.ts", schemaTemplate())
  write(".env", envTemplate(projectName))
  write("docker-compose.yml", dockerComposeTemplate(projectName))
  write(".supatype/kong.yml", kongTemplate())
  write(".supatype/pgbouncer.ini", pgbouncerIniTemplate())
  write(".supatype/userlist.txt", pgbouncerUserlistTemplate())
  write("seed.ts", seedTemplate(projectName))
  write(".gitignore", gitignoreTemplate())
}

// ─── Templates ───────────────────────────────────────────────────────────────

function configTemplate(projectName: string): string {
  return `import { defineConfig } from "@supatype/cli"

export default defineConfig({
  connection:
    process.env["DATABASE_URL"] ??
    "postgresql://postgres:postgres@localhost:5432/${projectName}",
  schema: "./schema/index.ts",
  output: {
    types: "./src/types/supatype.d.ts",
    client: "./src/lib/supatype.ts",
  },
  // Self-hosted production deployment (run: supatype self-host setup)
  // selfHost: {
  //   domain: "${projectName}.example.com",
  //   app: {
  //     dockerfile: "./Dockerfile",
  //     port: 3000,
  //   },
  //   ssl: {
  //     provider: "caddy",
  //     email: "you@example.com",
  //   },
  // },
})
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
  return `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/${projectName}
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

function dockerComposeTemplate(projectName: string): string {
  return `services:
  db:
    image: supabase/postgres:15.8.1.060
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}
      POSTGRES_DB: \${POSTGRES_DB:-${projectName}}
    ports:
      - "5432:5432"
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 20

  pgbouncer:
    image: edoburu/pgbouncer:1.23.1
    volumes:
      - ./.supatype/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./.supatype/userlist.txt:/etc/pgbouncer/userlist.txt:ro
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "pg_isready", "-h", "localhost", "-p", "6432", "-U", "postgres"]
      interval: 5s
      timeout: 5s
      retries: 10

  gotrue:
    image: supabase/gotrue:v2.164.0
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: "postgres://postgres:\${POSTGRES_PASSWORD:-postgres}@pgbouncer:6432/\${POSTGRES_DB:-${projectName}}?search_path=auth"
      GOTRUE_SITE_URL: \${SITE_URL:-http://localhost:3000}
      GOTRUE_JWT_SECRET: \${JWT_SECRET:-super-secret-jwt-token-change-in-production}
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_ADMIN_ROLES: service_role
      # Email autoconfirm — set to false and configure SMTP for production
      GOTRUE_MAILER_AUTOCONFIRM: \${GOTRUE_MAILER_AUTOCONFIRM:-true}
      GOTRUE_SMTP_HOST: \${SMTP_HOST:-}
      GOTRUE_SMTP_PORT: \${SMTP_PORT:-587}
      GOTRUE_SMTP_USER: \${SMTP_USER:-}
      GOTRUE_SMTP_PASS: \${SMTP_PASS:-}
      GOTRUE_SMTP_SENDER_NAME: \${SMTP_SENDER_NAME:-${projectName}}
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_RECOVERY: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_INVITE: /auth/v1/verify
      GOTRUE_DISABLE_SIGNUP: \${DISABLE_SIGNUP:-false}
    ports:
      - "9999:9999"
    depends_on:
      pgbouncer:
        condition: service_healthy

  postgrest:
    image: postgrest/postgrest:v12.2.8
    environment:
      PGRST_DB_URI: postgresql://authenticator:\${POSTGRES_PASSWORD:-postgres}@pgbouncer:6432/\${POSTGRES_DB:-${projectName}}
      PGRST_DB_SCHEMA: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${JWT_SECRET:-super-secret-jwt-token-change-in-production}
      PGRST_DB_EXTRA_SEARCH_PATH: public,extensions
      PGRST_DB_POOL: 3
    ports:
      - "3000:3000"
    depends_on:
      pgbouncer:
        condition: service_healthy

  minio:
    image: minio/minio:RELEASE.2024-11-07T00-52-20Z
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: supatype
      MINIO_ROOT_PASSWORD: supatype-secret
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 10

  storage:
    image: ghcr.io/supatype/storage:latest
    environment:
      PORT: 5000
      DATABASE_URL: "postgresql://postgres:\${POSTGRES_PASSWORD:-postgres}@pgbouncer:6432/\${POSTGRES_DB:-${projectName}}"
      JWT_SECRET: \${JWT_SECRET:-super-secret-jwt-token-change-in-production}
      S3_ENDPOINT: http://minio:9000
      S3_REGION: us-east-1
      S3_ACCESS_KEY: supatype
      S3_SECRET_KEY: supatype-secret
      S3_FORCE_PATH_STYLE: "true"
    ports:
      - "5000:5000"
    depends_on:
      pgbouncer:
        condition: service_healthy
      minio:
        condition: service_healthy

  studio:
    image: ghcr.io/supatype/studio:latest
    ports:
      - "3002:3002"

  kong:
    image: kong:3.6
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /etc/kong/kong.yml
      KONG_PROXY_ACCESS_LOG: /dev/stdout
      KONG_ADMIN_ACCESS_LOG: /dev/stdout
      KONG_PROXY_ERROR_LOG: /dev/stderr
      KONG_ADMIN_ERROR_LOG: /dev/stderr
    volumes:
      - ./.supatype/kong.yml:/etc/kong/kong.yml:ro
    ports:
      - "8000:8000"
    depends_on:
      - postgrest
      - gotrue
      - storage
      - studio

${APP_COMPOSE_MARKER}
  # app:
  #   build:
  #     context: .
  #     dockerfile: ./Dockerfile
  #   ports:
  #     - "3000:3000"
  #   environment:
  #     SUPATYPE_URL: http://kong:8000
  #     SUPATYPE_ANON_KEY: \${ANON_KEY}
  #     SUPATYPE_SERVICE_ROLE_KEY: \${SERVICE_ROLE_KEY}
  #   volumes:
  #     - .:/app
  #     - /app/node_modules
  #   depends_on:
  #     kong:
  #       condition: service_healthy

volumes:
  db-data:
  minio-data:
`
}

function kongTemplate(): string {
  return `_format_version: "3.0"

services:
  - name: rest-v1
    url: http://postgrest:3000
    routes:
      - name: rest-v1-all
        strip_path: true
        paths:
          - /rest/v1/
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - PATCH
            - DELETE
            - OPTIONS
          headers:
            - Authorization
            - Content-Type
            - apikey
            - Prefer
          credentials: true

  - name: graphql-v1
    url: http://postgrest:3000/rpc/graphql
    routes:
      - name: graphql-v1-all
        strip_path: true
        paths:
          - /graphql/v1
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - OPTIONS
          headers:
            - Authorization
            - Content-Type
            - apikey
          credentials: true

  - name: auth-v1
    url: http://gotrue:9999
    routes:
      - name: auth-v1-all
        strip_path: true
        paths:
          - /auth/v1/
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - PUT
            - DELETE
            - OPTIONS
          headers:
            - Authorization
            - Content-Type
            - apikey
          credentials: true

  - name: storage-v1
    url: http://storage:5000
    routes:
      - name: storage-v1-all
        strip_path: true
        paths:
          - /storage/v1/
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - PUT
            - DELETE
            - OPTIONS
          headers:
            - Authorization
            - Content-Type
            - apikey
            - x-upsert
          credentials: true

  - name: studio
    url: http://studio:3002
    routes:
      - name: studio-all
        strip_path: true
        paths:
          - /studio/
    plugins:
      - name: cors
        config:
          origins:
            - "*"
          methods:
            - GET
            - POST
            - OPTIONS
          headers:
            - Authorization
            - Content-Type
          credentials: true

${KONG_APP_MARKER}
  # - name: app
  #   url: http://app:3000
  #   routes:
  #     - name: app-root
  #       paths:
  #         - /
  #       strip_path: false
`
}

function pgbouncerIniTemplate(): string {
  return `[databases]
# Forward all databases to Postgres (Docker service name: db)
* = host=db port=5432

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
# trust = accept any client on the internal Docker network (safe for local dev)
auth_type = trust
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 20
max_db_connections = 60
max_client_conn = 100
# Required for PostgREST compatibility
server_reset_query = DEALLOCATE ALL
ignore_startup_parameters = extra_float_digits
`
}

function pgbouncerUserlistTemplate(): string {
  return `# PgBouncer userlist — auth_type = trust for local dev, so passwords here are unused.
# For production, this file is regenerated by: supatype self-host setup
`
}

function seedTemplate(projectName: string): string {
  return `import { sql } from "@supatype/cli/seed"

// Connect using DATABASE_URL from environment
const db = sql(
  process.env["DATABASE_URL"] ??
    "postgresql://postgres:postgres@localhost:5432/${projectName}",
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
# Generated by supatype push
src/types/supatype.d.ts
src/lib/supatype.ts
`
}
