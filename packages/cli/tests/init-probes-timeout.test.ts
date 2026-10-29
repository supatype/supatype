import { afterEach, describe, expect, it, vi } from "vitest"
import type { DockerAnswer, DockerRunner } from "../src/docker-exec.js"
import { dockerPortReader, reservedComposePorts } from "../src/dev-ports.js"
import { probeDockerDaemonAsync } from "../src/docker-runtime.js"
import { resolveInitDependencyVersions, initDependencyVersionsFallback } from "../src/init-dependency-versions.js"

/**
 * `init -y` took 16 to 27 seconds on a developer machine, and past 58 under load: it asked Docker
 * four things one after another with no limit (`docker info` alone took 14 seconds, and a paused
 * Docker Desktop can hang it) and gave the npm registry 10 seconds. A question that does not answer
 * now gives up after a short limit and init carries on as it does when Docker says nothing.
 */
const hangs: DockerRunner = () => new Promise<DockerAnswer>(() => undefined)

afterEach(() => {
  vi.unstubAllGlobals()
})

/** `work` settled within `ms`, or a rejection saying it did not. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

describe("init's questions to Docker and npm", () => {
  it("reads no reserved ports from a Docker that does not answer, rather than waiting on it", async () => {
    expect((await within(2_000, reservedComposePorts(dockerPortReader(hangs, 100)))).size).toBe(0)
  })

  it("reports a Docker daemon that does not answer, rather than waiting on it", async () => {
    const probe = await within(2_000, probeDockerDaemonAsync(hangs, 100))
    expect(probe).toMatchObject({ ok: false, reason: "daemon_unavailable" })
    expect(probe.ok === false ? probe.detail : "").toMatch(/did not answer within/)
  })

  it("falls back to the CLI's own versions when the registry does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    )
    expect(await within(4_500, resolveInitDependencyVersions())).toEqual(initDependencyVersionsFallback())
  }, 15_000)
})
