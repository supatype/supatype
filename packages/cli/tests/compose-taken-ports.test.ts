import { describe, expect, it, vi } from "vitest"

/**
 * Issue 57: `self-host compose up` while another stack held 8333 failed in Docker ("port is already
 * allocated") after starting the db container, which the next `up` found with no network. `up` now
 * checks every port the compose file publishes first, and a port its own running containers hold is
 * not taken.
 */
const docker = vi.hoisted(() => ({ config: "", ps: "" }))

vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDocker: async (args: readonly string[]) => ({
    status: 0,
    stdout: args.includes("config") ? docker.config : docker.ps,
    stderr: "",
    timedOut: false,
    missing: false,
  }),
}))

const { takenComposePorts } = await import("../src/compose-services.js")
const ctx = { composePath: "/p/.supatype/self-host/docker-compose.yml", projectRoot: "/p", projectName: "supatype-p" }

const CONFIG = JSON.stringify({
  services: {
    kong: { image: "kong", ports: [{ mode: "ingress", host_ip: "127.0.0.1", target: 8000, published: "18520", protocol: "tcp" }] },
    seaweedfs: { image: "seaweed", ports: [{ host_ip: "127.0.0.1", target: 8333, published: "8333" }] },
    db: { image: "postgres" },
  },
})

/** Ports something on the machine holds. */
const held = (...ports: number[]) => async (port: number) => ports.includes(port)

describe("takenComposePorts", () => {
  it("names each published port something else holds, with its service", async () => {
    docker.config = CONFIG
    docker.ps = ""
    await expect(takenComposePorts(ctx, held(8333))).resolves.toEqual([{ service: "seaweedfs", port: 8333 }])
  })

  it("does not count a port the stack's own running container publishes", async () => {
    docker.config = CONFIG
    docker.ps = JSON.stringify({
      Service: "seaweedfs",
      Name: "supatype-p-seaweedfs-1",
      State: "running",
      Status: "Up",
      Publishers: [{ URL: "127.0.0.1", TargetPort: 8333, PublishedPort: 8333, Protocol: "tcp" }],
    })
    await expect(takenComposePorts(ctx, held(8333))).resolves.toEqual([])
  })

  it("finds nothing taken when every port is free", async () => {
    docker.config = CONFIG
    docker.ps = ""
    await expect(takenComposePorts(ctx, held())).resolves.toEqual([])
  })
})
