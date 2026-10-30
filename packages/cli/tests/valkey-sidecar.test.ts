import { spawn, type ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import { drainStartUndo, resetDevShutdownForTests } from "../src/dev-shutdown.js"
import { nativeKeyspaceAddr } from "../src/native-keyspace.js"
import { answersPing, ensureValkeySidecar, valkeyRunArgs, type DockerResult } from "../src/valkey-sidecar.js"
import { freePort } from "./support/ports.js"

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

/**
 * A TCP listener in a process of its own (the probe blocks this one), on a free port: `reply` is
 * what it writes back to anything sent, or nothing at all when null. Resolves with its port.
 */
function listener(reply: string | null): Promise<number> {
  const answer = reply === null ? "" : `c.on("data",()=>c.write(${JSON.stringify(reply)}));`
  const script = `const s=require("net").createServer((c)=>{${answer}c.on("error",()=>{})});s.listen(0,"127.0.0.1",()=>console.log(s.address().port))`
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
})

/**
 * The same for the keyspace native Postgres serves: its port answering a connection is not RESP
 * answering, so the cache fell back to nothing rather than to the Valkey sidecar.
 */
describe("whether native Postgres serves the keyspace", () => {
  it("is not so when its port accepts the connection and never answers", async () => {
    const port = await listener(null)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(await nativeKeyspaceAddr(port)).toBeNull()
  })

  it("is so when its port answers PING", async () => {
    const port = await listener("+PONG\r\n")
    expect(await nativeKeyspaceAddr(port)).toBe(`127.0.0.1:${port}`)
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
    const sidecar = await ensureValkeySidecar("demo", { freePort: async () => port, docker, existingPort: await freePort() })
    expect(sidecar).toMatchObject({ addr: `127.0.0.1:${port}`, containerName: "supatype-valkey-dev-demo" })
    expect(await drainStartUndo()).toEqual([])
    expect(calls.at(-1)).toEqual(["rm", "-f", "supatype-valkey-dev-demo"])
  })
})

/**
 * Review of round 3b: the previous session's container, still on 6379, answered PING and was taken
 * for a Valkey this run did not start; and one on another port held it, so it was skipped as busy.
 * It is removed by name before anything is probed.
 */
describe("a container left by an earlier session", () => {
  afterEach(() => resetDevShutdownForTests())

  it("is removed before the existing Valkey is looked for, and a new sidecar started", async () => {
    const leftover = await listener("+PONG\r\n")
    const leftoverChild = listeners.at(-1)
    const docker = async (args: readonly string[]): Promise<DockerResult> => {
      if (args[0] === "rm" && leftoverChild !== undefined && leftoverChild.exitCode === null) {
        await new Promise((done) => {
          leftoverChild.once("exit", done)
          leftoverChild.kill()
        })
      }
      return { status: 0, stdout: "", stderr: "" }
    }
    const fresh = await listener("+PONG\r\n")
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const sidecar = await ensureValkeySidecar("demo", { freePort: async () => fresh, docker, existingPort: leftover })
    expect(sidecar).toMatchObject({ addr: `127.0.0.1:${fresh}`, containerName: "supatype-valkey-dev-demo", started: true })
  })
})

// Local test round 3c: dev said nothing when it used a Valkey already on 6379.
describe("a Valkey already running", () => {
  it("is used, with one line saying so, and no sidecar is started", async () => {
    const existing = await listener("+PONG\r\n")
    const calls: string[][] = []
    const docker = async (args: readonly string[]): Promise<DockerResult> => {
      calls.push([...args])
      return { status: 0, stdout: "", stderr: "" }
    }
    const logs: string[] = []
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")))

    const valkey = await ensureValkeySidecar("demo", { freePort: async () => null, docker, existingPort: existing })

    expect(valkey).toMatchObject({ addr: `127.0.0.1:${existing}`, containerName: null, started: false })
    expect(logs).toEqual([`[supatype] Using the Valkey already running at 127.0.0.1:${existing}.`])
    expect(calls.some((args) => args[0] === "run")).toBe(false)
  })
})
