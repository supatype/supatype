import type { Command } from "commander"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

export { scaffold }

export function registerInit(program: Command): void {
  program
    .command("init [name]")
    .description("Scaffold a new Definatype project")
    .action((name?: string) => {
      const projectName = name ?? "my-project"
      const dir = name ? resolve(process.cwd(), name) : process.cwd()

      if (name && existsSync(dir)) {
        console.error(`Directory already exists: ${dir}`)
        process.exit(1)
      }

      if (name) mkdirSync(dir, { recursive: true })

      scaffold(dir, projectName)

      console.log(`\nDefinatype project ready${name ? ` in ${name}/` : ""}.\n`)
      console.log("Next steps:")
      if (name) console.log(`  cd ${name}`)
      console.log("  pnpm install")
      console.log("  supatype dev        # start local Postgres + PostgREST")
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
JWT_SECRET=super-secret-jwt-token-change-in-production
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
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 20

  postgrest:
    image: postgrest/postgrest:v12.2.8
    environment:
      PGRST_DB_URI: postgresql://authenticator:\${POSTGRES_PASSWORD:-postgres}@db:5432/\${POSTGRES_DB:-${projectName}}
      PGRST_DB_SCHEMA: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${JWT_SECRET:-super-secret-jwt-token}
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy

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

  - name: graphql-v1
    url: http://postgrest:3000/rpc/graphql
    routes:
      - name: graphql-v1-all
        strip_path: true
        paths:
          - /graphql/v1
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
src/types/supatype.d.ts
src/lib/supatype.ts
`
}
