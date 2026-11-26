import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Pentest P-4: realtime started before its database login existed, Postgres answered 28P01, and the
 * service logged it and set exitCode 1 while the HTTP server kept the process alive. /health/live
 * stayed 200 and /health/ready 503 forever, so Kubernetes never restarted the pod.
 */
vi.mock("pg", () => {
  class Client {
    on(): void {}
    async connect(): Promise<void> {
      throw Object.assign(new Error('password authentication failed for user "p"'), { code: "28P01" })
    }
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] }
    }
    async end(): Promise<void> {}
  }
  class Pool {
    on(): void {}
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] }
    }
    async end(): Promise<void> {}
  }
  return { default: { Client, Pool }, Client, Pool }
})

const { RealtimeServer } = await import("../src/server.js")
const { ANY_PORT, testEnv } = await import("./fixtures/socket.js")
const { undeclaredChannels } = await import("./fixtures/fake-channel-db.js")

describe("a fatal replication startup failure", () => {
  let server: InstanceType<typeof RealtimeServer> | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    await server?.stop()
    server = null
  })

  it("fails liveness and asks the process to exit instead of sitting alive and unready", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exits: number[] = []
    server = new RealtimeServer(testEnv(ANY_PORT, { host: "127.0.0.1" }), {
      channelDb: undeclaredChannels(),
      onFatal: (code) => void exits.push(code),
    })
    await server.start()
    const port = server.port
    await server.waitForReplicationStartup()

    expect(exits).toEqual([1])
    const live = await fetch(`http://127.0.0.1:${port}/health/live`)
    expect(live.status).toBe(503)
  })
})
