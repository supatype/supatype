/**
 * Lightweight Valkey container for native `supatype dev` (REST response cache), used when native
 * Postgres does not serve the RESP keyspace itself: its archive has no pg_keyspace that can require
 * a password (Windows archives carry none), the project chose `cache.provider: "valkey"`, or the
 * keyspace did not answer a client that logs in (native-keyspace.ts, N-RB2).
 */

import { createConnection } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"
import { pushStartUndo } from "./dev-shutdown.js"
import { askDocker, DOCKER_PULL_TIMEOUT_MS, DOCKER_QUERY_TIMEOUT_MS } from "./docker-exec.js"
import { readDotEnvFiles } from "./env-file.js"
import { spawnFailureText, type SpawnOutcome } from "./error-message.js"
import { firstFreePort, KEYSPACE_PORT_BASE, KEYSPACE_PORT_SPAN } from "./postgres-ctl.js"

const DEFAULT_HOST = "127.0.0.1"
const VALKEY_ADDR_ENV = "SUPATYPE_VALKEY_ADDR"
const IMAGE = "valkey/valkey:8-alpine"

function containerName(projectName: string): string {
  const safe = projectName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48)
  return `supatype-valkey-dev-${safe}`
}

/** What a `docker` command came to: askDocker's answer, of which the sidecar reads these. */
export interface DockerResult extends SpawnOutcome {
  status: number | null
  stdout: string
  stderr: string
}

/** A RESP login: the user and password an `AUTH` sends. */
export interface RespCredentials {
  username: string
  password: string
}

/** One RESP command, as a client sends it: an array of bulk strings, lengths in bytes. */
function respCommand(args: readonly string[]): string {
  return `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`
}

/**
 * Whether Valkey (or Redis) answers on `host:port`: a RESP `PING` gets `+PONG` within `timeoutMs`.
 * Accepting the connection is not enough: an SSH tunnel or any other listener on 6379 did, and the
 * server's keyspace then timed out against it. With `credentials`, an `AUTH` goes first and has to
 * answer `+OK`: a keyspace requiring AUTH refuses PING without it (0.9.2 release test, N-RB2).
 */
export function answersPing(
  host: string,
  port: number,
  { timeoutMs = 800, credentials }: { timeoutMs?: number; credentials?: RespCredentials } = {},
): Promise<boolean> {
  const login = credentials === undefined ? "" : respCommand(["AUTH", credentials.username, credentials.password])
  const expected = `${credentials === undefined ? "" : "+OK\r\n"}+PONG`
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let reply = ""
    const done = (answered: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(answered)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once("connect", () => socket.write(`${login}${respCommand(["PING"])}`))
    socket.once("error", () => done(false))
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("latin1")
      if (reply.length >= expected.length) done(reply.startsWith(expected))
    })
  })
}

export interface ValkeySidecarResult {
  addr: string
  containerName: string | null
  started: boolean
}

/** A Valkey this run uses and did not start; "" for none, when the REST cache bypasses. */
export function externalValkey(addr: string): ValkeySidecarResult {
  return { addr, containerName: null, started: false }
}

/** No Valkey for this run: the REST cache bypasses. */
const NO_VALKEY = externalValkey("")

/** Runs `docker` with `args` and says what it came to; asynchronous, with a limit, so it never holds the event loop. */
export type DockerCaller = (args: readonly string[]) => Promise<DockerResult>

/** `docker <args>` within its limit: a `run` may pull the image first, anything else is a query. */
const askDockerFor: DockerCaller = (args) =>
  askDocker(args, { timeoutMs: args[0] === "run" ? DOCKER_PULL_TIMEOUT_MS : DOCKER_QUERY_TIMEOUT_MS })

/** What the sidecar asks of the machine; replaced in tests. */
export interface ValkeySidecarDeps {
  freePort: () => Promise<number | null>
  docker: DockerCaller
}

const machine: ValkeySidecarDeps = {
  // The keyspace's ports, since 6379 may be held by something that does not answer.
  freePort: () => firstFreePort(KEYSPACE_PORT_BASE, KEYSPACE_PORT_SPAN),
  docker: askDockerFor,
}

/**
 * Ensure Valkey is reachable for native dev: the one `SUPATYPE_VALKEY_ADDR` names, else this
 * project's own named Docker container on the first free port from 6379, since 6379 may be held by
 * something that does not answer. The previous session's container is removed first, so it is not
 * holding the port it would choose.
 *
 * 0.9.2 release test (N-S28): a Valkey answering on 127.0.0.1:6379 used to be taken as it was, and
 * that was routinely another project's sidecar, so two projects shared one REST cache. A Valkey this
 * run did not start is used only when SUPATYPE_VALKEY_ADDR names it.
 */
export async function ensureValkeySidecar(
  projectName: string,
  cwd: string,
  given: Partial<ValkeySidecarDeps> = {},
): Promise<ValkeySidecarResult> {
  const deps = { ...machine, ...given }
  const envAddr = namedValkeyAddr(cwd)
  if (envAddr) {
    console.log(`[supatype] Using the Valkey SUPATYPE_VALKEY_ADDR names (${envAddr}).`)
    return externalValkey(envAddr)
  }
  const name = containerName(projectName)
  await deps.docker(["rm", "-f", name])
  if ((await deps.docker(["info"])).status !== 0) {
    console.warn(
      "[supatype] ⚠  Valkey not available (Docker not running). " +
        "REST server cache (`cache({ server: true })`) will bypass until Valkey is reachable.",
    )
    return NO_VALKEY
  }
  const port = await deps.freePort()
  if (port === null) {
    console.warn(`[supatype] ⚠  No free port from ${KEYSPACE_PORT_BASE} for the Valkey sidecar, REST server cache will bypass.`)
    return NO_VALKEY
  }
  return (await startContainer(name, port, deps)) ? awaitReachable(name, port) : NO_VALKEY
}

/**
 * The Valkey SUPATYPE_VALKEY_ADDR names: the shell's, then `.env` and `.env.local`'s, as for the
 * port variables. It was read from the shell only, so one in .env was ignored (0.9.2 round 2, R2-S21).
 */
function namedValkeyAddr(cwd: string): string | undefined {
  const fromShell = process.env[VALKEY_ADDR_ENV]?.trim()
  return fromShell || readDotEnvFiles(cwd)[VALKEY_ADDR_ENV]?.trim() || undefined
}

/**
 * Starts the container and records its removal as an undo of dev's start; false, having said why,
 * when it would not start. A failed `docker run` may have created the container all the same (a
 * port Docker Desktop could not publish), which stayed `Created` until the next start removed it
 * (0.9.2 round 2, R2-S12): it is this project's own, by its name, so it is removed now.
 */
async function startContainer(name: string, port: number, deps: ValkeySidecarDeps): Promise<boolean> {
  const run = await deps.docker(valkeyRunArgs(name, port))
  if (run.status === 0) {
    pushStartUndo(() => stopValkeySidecar(name, deps.docker), { container: `the Valkey sidecar container (${name})` })
    return true
  }
  await stopValkeySidecar(name, deps.docker)
  console.warn(
    `[supatype] ⚠  Could not start Valkey sidecar: ${spawnFailureText(run)}\n` +
      "  REST server cache will bypass until Valkey is available.",
  )
  return false
}

/** Waits up to three seconds for the started container to answer PING on 127.0.0.1:`port`. */
async function awaitReachable(name: string, port: number): Promise<ValkeySidecarResult> {
  const addr = `${DEFAULT_HOST}:${port}`
  for (let i = 0; i < 30; i++) {
    if (await answersPing(DEFAULT_HOST, port, { timeoutMs: 100 })) {
      console.log(`[supatype] Valkey sidecar running (${addr})`)
      return { addr, containerName: name, started: true }
    }
    await sleep(100)
  }
  console.warn("[supatype] ⚠  Valkey sidecar started but not reachable yet, cache may bypass initially.")
  return { addr, containerName: name, started: true }
}

/** The `docker run` arguments for the sidecar, published on this machine only, on `port`. */
export function valkeyRunArgs(name: string, port: number): string[] {
  return ["run", "-d", "--name", name, "-p", `${DEFAULT_HOST}:${port}:6379`, IMAGE]
}

export async function stopValkeySidecar(containerName: string | null, docker: DockerCaller = askDockerFor): Promise<void> {
  if (!containerName) return
  await docker(["rm", "-f", containerName])
}
