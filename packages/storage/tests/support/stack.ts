/**
 * The storage service on a real Postgres for HTTP tests: a throwaway Postgres container carrying
 * the roles and the engine's storage SQL from `fixtures/`, and the service started in-process
 * against it. Needs Docker; `dockerAvailable` says whether the caller should skip.
 */
import { spawnSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import pg from "pg"
import { isShape, isString } from "../../src/json.js"

export const FIXTURES = join(import.meta.dirname, "..", "fixtures")

export const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0

function docker(args: string[]): string {
  const res = spawnSync("docker", args, { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${res.stderr}`)
  return res.stdout.trim()
}

/** A Postgres 17 container on a free local port: its id and its URL. */
export function startPostgres(): { container: string; url: string } {
  const container = docker(["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:17-alpine"])
  const port = docker(["port", container, "5432"]).split(":").pop()
  return { container, url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` }
}

export async function connectWhenReady(url: string): Promise<pg.Client> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      return client
    } catch {
      await client.end().catch(() => undefined)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error("Postgres did not accept connections")
}

/** The roles the gateway issues, then the engine's SQL, in the order a push applies it. */
export async function provision(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  `)
  await client.query(readFileSync(join(FIXTURES, "auth.gen.sql"), "utf8"))
  await client.query(readFileSync(join(FIXTURES, "storage.gen.sql"), "utf8"))
}

/** Starts the service in-process on `databaseUrl` and waits until it reports healthy. */
export async function startService(databaseUrl: string, jwtSecret: string): Promise<{ server: Server; base: string }> {
  process.env["DATABASE_URL"] = databaseUrl
  process.env["JWT_SECRET"] = jwtSecret
  const { createServer } = await import("../../src/server.js")
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("storage service has no TCP address")
  const base = `http://127.0.0.1:${address.port}`
  for (let attempt = 0; attempt < 60; attempt++) {
    const health: unknown = await (await fetch(`${base}/health`)).json()
    if (isShape({ status: isString })(health) && health.status === "ok") return { server, base }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("storage service never became ready")
}

/** An HS256 token for `claims`, signed with `secret` as the gateway signs one. */
export function sign(secret: string, claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
  const head = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}`
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`
}
