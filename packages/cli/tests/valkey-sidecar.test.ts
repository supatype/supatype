import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { drainStartUndo, resetDevShutdownForTests } from "../src/dev-shutdown.js"
import { answersPing, ensureValkeySidecar, valkeyRunArgs, type DockerResult } from "../src/valkey-sidecar.js"

/**
 * Local test round 3: native dev's Valkey sidecar was published on 0.0.0.0:6379, open to the
 * network, while dev printed 127.0.0.1:6379. It is published on this machine only.
 */
describe("the Valkey sidecar container", () => {
  it("is published on 127.0.0.1 only, on the port chosen for it", () => {
    const args = valkeyRunArgs("supatype-valkey-dev-demo", 6381)
    const publish = args[args.indexOf("-p") + 1]
    expect(publish).toBe("127.0.0.1:6381:6379")
  })
})

const listeners: ChildProcess[] = []
afterEach(() => {
  for (const child of listeners.splice(0)) child.kill()
  vi.restoreAllMocks()
})

/** A project directory with no .env, so only the shell can name a Valkey. */
const noEnvDir = mkdtempSync(join(tmpdir(), "supatype-valkey-sidecar-"))
afterAll(() => rmSync(noEnvDir, { recursive: true, force: true }))

/**
 * A TCP listener in a process of its own (the probe blocks this one), on a free port: `reply` is
 * what it writes back to anything sent, or nothing at all when null. Resolves with its port.
 */
function listener(reply: string | null): Promise<number> {
  const answer = reply === null ? "" : `c.on("data",()=>c.write(${JSON.stringify(reply)}));`
  return spawnListener(`(c)=>{${answer}c.on("error",()=>{})}`)
}

/**
 * A listener that answers as a keyspace requiring AUTH with `password` does: PING is NOAUTH until
 * an AUTH carrying the password, after which it is PONG.
 */
function authListener(password: string): Promise<number> {
  const r = JSON.stringify({ ok: "+OK\r\n", pong: "+PONG\r\n", noauth: "-NOAUTH Authentication required.\r\n", wrong: "-WRONGPASS invalid\r\n" })
  const pw = JSON.stringify(password)
  return spawnListener(
    `(c)=>{const r=${r};let authed=false;c.on("data",(d)=>{const s=String(d);` +
      `if(s.includes("AUTH")){authed=s.includes(${pw});c.write(authed?r.ok:r.wrong)}` +
      `if(s.includes("PING"))c.write(authed?r.pong:r.noauth)});c.on("error",()=>{})}`,
  )
}

/** Runs a server with `handler` in a process of its own, on a free port; resolves with the port. */
function spawnListener(handler: string): Promise<number> {
  const script = `const s=require("net").createServer(${handler});s.listen(0,"127.0.0.1",()=>console.log(s.address().port))`
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] })
  listeners.push(child)
  return new Promise((resolve) => child.stdout?.once("data", (data: Buffer) => resolve(Number(String(data).trim()))))
}

/**
 * Local test round 3b check 18: anything that accepted a connection on 6379 was taken for Valkey,
 * so a listener that never answers (an SSH tunnel) left the server's keyspace timing out.
 */
describe("whether something on a port is Valkey", () => {
  it("is so only when it answers PING with +PONG", async () => {
    expect(await answersPing("127.0.0.1", await listener("+PONG\r\n"))).toBe(true)
  })

  it("is not a listener that accepts the connection and never answers", async () => {
    expect(await answersPing("127.0.0.1", await listener(null))).toBe(false)
  })

  it("is not a listener that answers something else", async () => {
    expect(await answersPing("127.0.0.1", await listener("SSH-2.0-OpenSSH_9.6\r\n"))).toBe(false)
  })

  // N-RB2: the native keyspace refuses PING until AUTH, so the probe logs in first.
  it("is so for a keyspace requiring AUTH when the probe logs in with its password", async () => {
    const port = await authListener("s3cret")
    expect(await answersPing("127.0.0.1", port, { credentials: { username: "supatype", password: "s3cret" } })).toBe(true)
  })

  it("is not so for a keyspace requiring AUTH without the password, or with a wrong one", async () => {
    const port = await authListener("s3cret")
    expect(await answersPing("127.0.0.1", port)).toBe(false)
    expect(await answersPing("127.0.0.1", port, { credentials: { username: "supatype", password: "nope" } })).toBe(false)
  })
})

/**
 * An interrupted start undoes what it began. The container is recorded the moment `docker run`
 * starts it, so a Ctrl+C while dev still waits for it to answer leaves no container behind.
 */
describe("an interrupted start after the Valkey sidecar started", () => {
  afterEach(() => resetDevShutdownForTests())

  it("removes the container", async () => {
    const calls: string[][] = []
    const docker = async (args: readonly string[]): Promise<DockerResult> => {
      calls.push([...args])
      return { status: 0, stdout: "", stderr: "" }
    }
    const port = await listener("+PONG\r\n")
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const sidecar = await ensureValkeySidecar("demo", noEnvDir, { freePort: async () => port, docker })
    expect(sidecar).toMatchObject({ addr: `127.0.0.1:${port}`, containerName: "supatype-valkey-dev-demo" })
    expect(await drainStartUndo()).toEqual([])
    expect(calls.at(-1)).toEqual(["rm", "-f", "supatype-valkey-dev-demo"])
  })
})

/**
 * Review of round 3b: the previous session's container, still on 6379, held the port the new one
 * would choose. It is removed by name before the free port is chosen and the new one started.
 */
describe("a container left by an earlier session", () => {
  afterEach(() => resetDevShutdownForTests())

  it("is removed before a new sidecar is started", async () => {
    const calls: string[][] = []
    const docker = async (args: readonly string[]): Promise<DockerResult> => {
      calls.push([...args])
      return { status: 0, stdout: "", stderr: "" }
    }
    const fresh = await listener("+PONG\r\n")
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const sidecar = await ensureValkeySidecar("demo", noEnvDir, { freePort: async () => fresh, docker })
    expect(sidecar).toMatchObject({ addr: `127.0.0.1:${fresh}`, containerName: "supatype-valkey-dev-demo", started: true })
    const removed = calls.findIndex((args) => args[0] === "rm" && args[2] === "supatype-valkey-dev-demo")
    expect(removed).toBeGreaterThanOrEqual(0)
    expect(removed).toBeLessThan(calls.findIndex((args) => args[0] === "run"))
  })
})

/**
 * 0.9.2 release test (N-S28): native dev used whatever Valkey answered on 127.0.0.1:6379, another
 * project's sidecar included, so two projects shared one REST cache. Each project starts its own;
 * a Valkey already running is used only when SUPATYPE_VALKEY_ADDR names it.
 */
describe("a Valkey already running", () => {
  afterEach(() => {
    resetDevShutdownForTests()
    vi.unstubAllEnvs()
  })

  /** A docker stand-in that records each call and succeeds. */
  function recordingDocker(calls: string[][]): (args: readonly string[]) => Promise<DockerResult> {
    return async (args) => {
      calls.push([...args])
      return { status: 0, stdout: "", stderr: "" }
    }
  }

  it("is not taken for this project's: the project starts its own sidecar on a free port", async () => {
    const anotherProjects = await listener("+PONG\r\n")
    const own = await listener("+PONG\r\n")
    const calls: string[][] = []
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const valkey = await ensureValkeySidecar("demo", noEnvDir, { freePort: async () => own, docker: recordingDocker(calls) })

    expect(valkey).toMatchObject({ addr: `127.0.0.1:${own}`, containerName: "supatype-valkey-dev-demo", started: true })
    expect(calls.some((args) => args[0] === "run")).toBe(true)
  })

  it("is used when SUPATYPE_VALKEY_ADDR names it, and no sidecar is started", async () => {
    const named = await listener("+PONG\r\n")
    vi.stubEnv("SUPATYPE_VALKEY_ADDR", `127.0.0.1:${named}`)
    const calls: string[][] = []
    const logs: string[] = []
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")))

    const valkey = await ensureValkeySidecar("demo", noEnvDir, { freePort: async () => null, docker: recordingDocker(calls) })

    expect(valkey).toMatchObject({ addr: `127.0.0.1:${named}`, containerName: null, started: false })
    expect(logs).toEqual([`[supatype] Using the Valkey SUPATYPE_VALKEY_ADDR names (127.0.0.1:${named}).`])
    expect(calls).toEqual([])
  })

  // 0.9.2 round 2 (R2-S21): read from the shell only, while the port variables are read from the
  // shell over .env, so a SUPATYPE_VALKEY_ADDR in .env was ignored and a sidecar started.
  it("is used when .env names it, and the shell's SUPATYPE_VALKEY_ADDR wins over .env's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-valkey-dotenv-"))
    try {
      writeFileSync(join(dir, ".env"), "SUPATYPE_VALKEY_ADDR=127.0.0.1:6391\n")
      vi.spyOn(console, "log").mockImplementation(() => undefined)
      const calls: string[][] = []
      const fromFile = await ensureValkeySidecar("demo", dir, { freePort: async () => null, docker: recordingDocker(calls) })
      expect(fromFile).toMatchObject({ addr: "127.0.0.1:6391", containerName: null, started: false })
      expect(calls).toEqual([])
      vi.stubEnv("SUPATYPE_VALKEY_ADDR", "127.0.0.1:6392")
      expect(await ensureValkeySidecar("demo", dir, { docker: recordingDocker(calls) })).toMatchObject({ addr: "127.0.0.1:6392" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * 0.9.2 round 2 (R2-S12): a `docker run` that failed (its port refused on the Docker Desktop side)
 * had already created the container, which stayed `Created` until the next start removed it.
 */
describe("a sidecar whose docker run failed", () => {
  it("is removed by its name, and dev carries on with the cache bypassed", async () => {
    const calls: string[][] = []
    const docker = async (args: readonly string[]): Promise<DockerResult> => {
      calls.push([...args])
      return args[0] === "run"
        ? { status: 125, stdout: "", stderr: "docker: Error response from daemon: ports are not available" }
        : { status: 0, stdout: "", stderr: "" }
    }
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const valkey = await ensureValkeySidecar("demo", noEnvDir, { freePort: async () => 6390, docker })
    expect(valkey).toMatchObject({ addr: "", containerName: null })
    const run = calls.findIndex((args) => args[0] === "run")
    expect(calls.slice(run + 1)).toEqual([["rm", "-f", "supatype-valkey-dev-demo"]])
  })
})
