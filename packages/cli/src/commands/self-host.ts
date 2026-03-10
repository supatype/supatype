import type { Command } from "commander"
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs"
import { resolve, join } from "node:path"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { signJwt } from "../jwt.js"

export function registerSelfHost(program: Command): void {
  const selfHostCmd = program
    .command("self-host")
    .description("Manage self-hosted production deployments")

  selfHostCmd
    .command("setup")
    .description("Generate a production-ready deploy/ directory with Caddy, PgBouncer, and all secrets")
    .option("--domain <domain>", "Production domain (e.g. api.example.com)")
    .option("--app-dockerfile <path>", "Path to your app Dockerfile (omit to skip app service)")
    .option("--app-port <port>", "Port your app listens on", "3000")
    .option("--ssl-email <email>", "Email address for Let's Encrypt registration")
    .action((opts: { domain?: string; appDockerfile?: string; appPort: string; sslEmail?: string }) => {
      setup(process.cwd(), opts)
    })

  selfHostCmd
    .command("status")
    .description("Show running service health for the production stack")
    .action(() => {
      runDockerCompose(["ps", "--format", "table"], "status")
    })

  selfHostCmd
    .command("logs")
    .description("Tail logs from production services")
    .option("--service <name>", "Show logs for a specific service only")
    .option("--follow", "Follow log output")
    .action((opts: { service?: string; follow?: boolean }) => {
      const args = ["logs"]
      if (opts.follow) args.push("--follow")
      if (opts.service) args.push(opts.service)
      runDockerCompose(args, "logs")
    })

  selfHostCmd
    .command("backup")
    .description("Create a Postgres dump and store it locally")
    .option("--output <path>", "Output file path", `./backups/backup-${timestamp()}.sql.gz`)
    .action((opts: { output: string }) => {
      backup(process.cwd(), opts.output)
    })

  selfHostCmd
    .command("update")
    .description("Pull latest images and restart the production stack")
    .action(() => {
      update(process.cwd())
    })
}

// ─── Setup ────────────────────────────────────────────────────────────────────

interface SetupOpts {
  domain?: string
  appDockerfile?: string
  appPort: string
  sslEmail?: string
}

function setup(cwd: string, opts: SetupOpts): void {
  // Load domain from opts or supatype.config.ts
  const domain = opts.domain ?? loadDomainFromConfig(cwd)
  if (!domain) {
    console.error(
      "Error: --domain is required (or set selfHost.domain in supatype.config.ts)",
    )
    process.exit(1)
  }

  const deployDir = resolve(cwd, "deploy")
  mkdirSync(deployDir, { recursive: true })

  const write = (rel: string, content: string) => {
    const full = join(deployDir, rel)
    mkdirSync(resolve(full, ".."), { recursive: true })
    writeFileSync(full, content, "utf8")
    console.log(`  created  deploy/${rel}`)
  }

  // Generate all secrets
  const pgPassword = randomBytes(24).toString("hex")
  const jwtSecret = randomBytes(32).toString("hex")
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 10 * 365 * 24 * 60 * 60 // 10 years
  const anonKey = signJwt({ iss: "supatype", role: "anon", iat: now, exp }, jwtSecret)
  const serviceKey = signJwt({ iss: "supatype", role: "service_role", iat: now, exp }, jwtSecret)

  console.log("\nGenerating production deployment files...\n")

  write(".env.production", envProductionTemplate(domain, pgPassword, jwtSecret, anonKey, serviceKey))
  write("docker-compose.yml", productionComposeTemplate(domain, opts))
  write("Caddyfile", caddyfileTemplate(domain, opts.sslEmail))
  write("pgbouncer.ini", productionPgbouncerIni())
  write("userlist.txt", productionUserlist(pgPassword))
  write("deploy.sh", deployScript(domain))

  // Copy kong.yml if it exists
  const kongSrc = resolve(cwd, ".supatype/kong.yml")
  if (existsSync(kongSrc)) {
    copyFileSync(kongSrc, join(deployDir, "kong.yml"))
    console.log("  copied   deploy/kong.yml")
  }

  // Make deploy.sh executable on Unix
  try {
    spawnSync("chmod", ["+x", join(deployDir, "deploy.sh")])
  } catch { /* non-Unix, ignore */ }

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  SAVE THESE SECRETS — they will not be shown again!         ║
╚══════════════════════════════════════════════════════════════╝

POSTGRES_PASSWORD=${pgPassword}
JWT_SECRET=${jwtSecret}
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceKey}

These are also written to deploy/.env.production — back it up securely.
DO NOT commit deploy/.env.production to source control.

Next steps:
  1. Copy the deploy/ directory to your VPS
  2. SSH into the VPS and run: bash deploy.sh
  3. Your app will be live at https://${domain}
`)
}

// ─── Operations ───────────────────────────────────────────────────────────────

function runDockerCompose(args: string[], label: string): void {
  const deployDir = resolve(process.cwd(), "deploy")
  if (!existsSync(join(deployDir, "docker-compose.yml"))) {
    console.error("deploy/docker-compose.yml not found. Run: supatype self-host setup")
    process.exit(1)
  }
  const result = spawnSync("docker", ["compose", "-f", join(deployDir, "docker-compose.yml"), ...args], {
    stdio: "inherit",
    cwd: deployDir,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function backup(cwd: string, outputPath: string): void {
  const deployDir = resolve(cwd, "deploy")
  if (!existsSync(join(deployDir, "docker-compose.yml"))) {
    console.error("deploy/docker-compose.yml not found. Run: supatype self-host setup")
    process.exit(1)
  }

  const fullOutput = resolve(cwd, outputPath)
  mkdirSync(resolve(fullOutput, ".."), { recursive: true })

  console.log(`Backing up database to ${outputPath}...`)
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f", join(deployDir, "docker-compose.yml"),
      "exec", "-T", "db",
      "sh", "-c", "pg_dumpall -U postgres | gzip",
    ],
    { cwd: deployDir, encoding: "buffer" },
  )

  if (result.status !== 0) {
    console.error("Backup failed:", result.stderr?.toString())
    process.exit(1)
  }

  writeFileSync(fullOutput, result.stdout)
  console.log(`Backup saved to ${outputPath}`)
}

function update(cwd: string): void {
  const deployDir = resolve(cwd, "deploy")
  console.log("Pulling latest images...")
  spawnSync("docker", ["compose", "-f", join(deployDir, "docker-compose.yml"), "pull"], {
    stdio: "inherit",
    cwd: deployDir,
  })
  console.log("Restarting services...")
  spawnSync("docker", ["compose", "-f", join(deployDir, "docker-compose.yml"), "up", "-d", "--wait"], {
    stdio: "inherit",
    cwd: deployDir,
  })
  console.log("Update complete.")
}

// ─── Config helpers ───────────────────────────────────────────────────────────

function loadDomainFromConfig(cwd: string): string | undefined {
  try {
    const { loadConfig } = require("../config.js") as typeof import("../config.js")
    const config = loadConfig(cwd)
    return (config as { selfHost?: { domain?: string } }).selfHost?.domain
  } catch {
    return undefined
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

// ─── Production templates ─────────────────────────────────────────────────────

function envProductionTemplate(
  domain: string,
  pgPassword: string,
  jwtSecret: string,
  anonKey: string,
  serviceKey: string,
): string {
  return `# Production secrets — DO NOT commit this file to source control
# Generated by: supatype self-host setup

DOMAIN=${domain}

POSTGRES_PASSWORD=${pgPassword}
POSTGRES_DB=supatype

JWT_SECRET=${jwtSecret}
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceKey}

SITE_URL=https://${domain}

# SMTP — required for user email confirmation in production
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_SENDER_NAME=Supatype
`
}

function productionComposeTemplate(domain: string, opts: SetupOpts): string {
  const appService = opts.appDockerfile
    ? `
  app:
    build:
      context: ..
      dockerfile: ${opts.appDockerfile}
    environment:
      SUPATYPE_URL: http://kong:8000
      SUPATYPE_ANON_KEY: \${ANON_KEY}
      SUPATYPE_SERVICE_ROLE_KEY: \${SERVICE_ROLE_KEY}
    networks:
      - supatype
    depends_on:
      - kong
    restart: unless-stopped
`
    : ""

  return `# Production docker-compose — generated by supatype self-host setup
# Run with: docker compose up -d (from within the deploy/ directory)

services:
  db:
    image: supabase/postgres:15.8.1.060
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB:-supatype}
    volumes:
      - db-data:/var/lib/postgresql/data
    networks:
      - supatype
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 20
    restart: unless-stopped

  pgbouncer:
    image: edoburu/pgbouncer:1.23.1
    volumes:
      - ./pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./userlist.txt:/etc/pgbouncer/userlist.txt:ro
    networks:
      - supatype
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  gotrue:
    image: supabase/gotrue:v2.164.0
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: "postgres://postgres:\${POSTGRES_PASSWORD}@pgbouncer:6432/\${POSTGRES_DB:-supatype}?search_path=auth"
      GOTRUE_SITE_URL: https://${domain}
      GOTRUE_JWT_SECRET: \${JWT_SECRET}
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_MAILER_AUTOCONFIRM: false
      GOTRUE_SMTP_HOST: \${SMTP_HOST}
      GOTRUE_SMTP_PORT: \${SMTP_PORT:-587}
      GOTRUE_SMTP_USER: \${SMTP_USER}
      GOTRUE_SMTP_PASS: \${SMTP_PASS}
      GOTRUE_SMTP_SENDER_NAME: \${SMTP_SENDER_NAME:-Supatype}
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_RECOVERY: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_INVITE: /auth/v1/verify
      GOTRUE_DISABLE_SIGNUP: false
    networks:
      - supatype
    depends_on:
      pgbouncer:
        condition: service_started
    restart: unless-stopped

  postgrest:
    image: postgrest/postgrest:v12.2.8
    environment:
      PGRST_DB_URI: postgresql://authenticator:\${POSTGRES_PASSWORD}@pgbouncer:6432/\${POSTGRES_DB:-supatype}
      PGRST_DB_SCHEMA: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${JWT_SECRET}
      PGRST_DB_EXTRA_SEARCH_PATH: public,extensions
      PGRST_DB_POOL: 3
    networks:
      - supatype
    depends_on:
      pgbouncer:
        condition: service_started
    restart: unless-stopped

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
      - ./kong.yml:/etc/kong/kong.yml:ro
    networks:
      - supatype
    depends_on:
      - postgrest
      - gotrue
    restart: unless-stopped
${appService}
  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks:
      - supatype
    depends_on:
      - kong
    restart: unless-stopped

networks:
  supatype:
    driver: bridge

volumes:
  db-data:
  caddy-data:
  caddy-config:
`
}

function caddyfileTemplate(domain: string, sslEmail?: string): string {
  const emailLine = sslEmail ? `\n\ttls ${sslEmail}\n` : ""
  return `${domain} {${emailLine}
\treverse_proxy kong:8000

\theader {
\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"
\t\tX-Frame-Options "SAMEORIGIN"
\t\tX-Content-Type-Options "nosniff"
\t}
}
`
}

function productionPgbouncerIni(): string {
  return `[databases]
* = host=db port=5432

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 20
max_db_connections = 60
max_client_conn = 100
server_reset_query = DEALLOCATE ALL
ignore_startup_parameters = extra_float_digits
`
}

function productionUserlist(pgPassword: string): string {
  // PgBouncer md5 format: "md5" + md5(password + username)
  const md5Hash = (s: string) => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    return createHash("md5").update(s).digest("hex")
  }
  const postgresHash = "md5" + md5Hash(pgPassword + "postgres")
  const authenticatorHash = "md5" + md5Hash(pgPassword + "authenticator")

  return `# PgBouncer userlist — generated by supatype self-host setup
# Regenerate by running: supatype self-host setup
"postgres" "${postgresHash}"
"authenticator" "${authenticatorHash}"
`
}

function deployScript(domain: string): string {
  return `#!/usr/bin/env bash
# deploy.sh — generated by supatype self-host setup
# Run once on a fresh VPS: bash deploy.sh
set -euo pipefail

DOMAIN="${domain}"

echo "Checking prerequisites..."

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "Docker not found. Installing..."
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$USER"
  newgrp docker
fi

# Check ports 80 and 443 are available
for port in 80 443; do
  if ss -tlnp 2>/dev/null | grep -q ":$port " ; then
    echo "Error: Port $port is already in use. Free it before running deploy.sh."
    exit 1
  fi
done

echo "Loading environment..."
if [ ! -f .env.production ]; then
  echo "Error: .env.production not found in $(pwd)"
  exit 1
fi

# Export env vars from .env.production
set -a; source .env.production; set +a

echo "Starting services..."
docker compose up -d --wait

echo "Waiting for health checks..."
timeout=120
elapsed=0
while ! docker compose ps --format json 2>/dev/null | grep -q '"Health":"healthy"'; do
  sleep 5
  elapsed=$((elapsed + 5))
  if [ $elapsed -ge $timeout ]; then
    echo "Timeout waiting for services to become healthy."
    docker compose ps
    exit 1
  fi
done

echo ""
echo "Deployment complete!"
echo "Your app is live at: https://$DOMAIN"
`
}
