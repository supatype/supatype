import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DockerAnswer, DockerRunner } from "../src/docker-exec.js"
import { waitKongReady } from "../src/dev-compose.js"
import { redactSecrets } from "../src/error-message.js"
import { composeStackWatch } from "../src/stack-exit-watch.js"

/**
 * Issue 38: with the server container exited (a fatal config error), dev sat at "Waiting for API
 * gateway..." for 120 s, then failed naming the gateway's health, then removed the containers, so
 * the server's log was gone too. The wait now watches the stack's essential services: once one has
 * exited it stops, says which and with what exit code, and prints its last log lines with the
 * project's secrets taken out, before anything is cleaned up.
 */

const SECRET = "hunter2-very-secret"
const SERVER_LOG = [
  "starting supatype server",
  `fatal: Failed to load configuration: unexpected character "-" in variable name`,
  `SUPATYPE_ADMIN_PASSWORD=${SECRET}`,
].join("\n")

let cwd = ""
let gateway: Server
let port = 0
let printed: string[] = []
const asked: string[][] = []

/** A Docker whose compose stack has `server` exited with code 1 and everything else running. */
const serverExited: DockerRunner = (args) => {
  asked.push([...args])
  const reply = (stdout: string): Promise<DockerAnswer> => Promise.resolve({ status: 0, stdout, stderr: "", timedOut: false, missing: false })
  if (args.includes("ps")) {
    return reply([
      JSON.stringify({ Service: "db", Name: "p-db-1", State: "running", ExitCode: 0 }),
      JSON.stringify({ Service: "kong", Name: "p-kong-1", State: "running", ExitCode: 0 }),
      JSON.stringify({ Service: "server", Name: "p-server-1", State: "exited", ExitCode: 1 }),
    ].join("\n"))
  }
  return reply(args.includes("logs") ? SERVER_LOG : "")
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "st-dead-server-"))
  writeFileSync(join(cwd, ".env"), `SUPATYPE_ADMIN_PASSWORD=${SECRET}\nSUPATYPE_KONG_PORT=1\n`)
  asked.length = 0
  printed = []
  const keep = (...parts: unknown[]): void => void printed.push(parts.map(String).join(" "))
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(keep)
  // Kong answering 503 for every upstream, as it does with the server down.
  gateway = createServer((_req, res) => res.writeHead(503).end())
  await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done))
  const address = gateway.address()
  if (address === null || typeof address === "string") throw new Error("the stand-in gateway has no port")
  port = address.port
})

afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((done) => gateway.close(() => done()))
  rmSync(cwd, { recursive: true, force: true })
})

describe("waiting for the gateway while the server container has exited", () => {
  it("stops at once, naming the server and its exit code, with its last log lines and no secret", async () => {
    const stack = { composePath: join(cwd, "docker-compose.yml"), cwd, project: "p" }
    const started = Date.now()
    const waited = waitKongReady(port, 120, { ...stack, watch: composeStackWatch(stack, serverExited) })
    await expect(waited).rejects.toThrow(/server container exited with code 1/)
    expect(Date.now() - started).toBeLessThan(10_000)
    const output = printed.join("\n")
    expect(output).toContain(`fatal: Failed to load configuration`)
    expect(output).not.toContain(SECRET)
    expect(output).toContain("SUPATYPE_ADMIN_PASSWORD=***")
    const logs = asked.find((args) => args.includes("logs"))
    expect(logs).toEqual(expect.arrayContaining(["--tail", "30", "server"]))
  }, 20_000)
})

describe("redactSecrets", () => {
  it("hides each secret wherever it appears, and the password of any connection string", () => {
    const log = "password=hunter2-very-secret\nconnecting to postgres://supatype_admin:s3cr3t-pw@db:5432/app"
    expect(redactSecrets(log, ["hunter2-very-secret", "abc"])).toBe(
      "password=***\nconnecting to postgres://supatype_admin:***@db:5432/app",
    )
  })

  it("leaves a value too short to be told from an ordinary word", () => {
    expect(redactSecrets("port 5432 is up", ["5432"])).toBe("port 5432 is up")
  })
})
