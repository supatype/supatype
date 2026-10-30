import { describe, expect, it } from "vitest"
import {
  addressPoolExhaustionHint,
  isAddressPoolExhausted,
  type DockerRun,
} from "../src/docker-address-pool.js"

/**
 * Every compose project gets its own network, and Docker carves each from a fixed set of address
 * pools. With enough stacks left behind, `compose up` fails with "all predefined address pools have
 * been fully subnetted", which names neither the cause nor the fix.
 */
const RAW =
  "Error response from daemon: all predefined address pools have been fully subnetted"

function fakeDocker(responses: Record<string, { status: number; stdout?: string; stderr?: string }>): {
  run: DockerRun
  calls: string[]
} {
  const calls: string[] = []
  const run: DockerRun = (args) => {
    const key = args.slice(0, 2).join(" ")
    calls.push(args.join(" "))
    const r = responses[key] ?? { status: 0 }
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }
  return { run, calls }
}

describe("isAddressPoolExhausted", () => {
  it("recognises Docker's message, in compose's output", () => {
    expect(isAddressPoolExhausted(`network supatype-acme_default  Error\n${RAW}`)).toBe(true)
  })

  it("does not match other compose failures", () => {
    expect(isAddressPoolExhausted("Bind for 127.0.0.1:54329 failed: port is already allocated")).toBe(false)
  })
})

describe("addressPoolExhaustionHint", () => {
  it("says what happened, how to free networks, and how many Supatype ones exist", () => {
    const { run } = fakeDocker({ "network ls": { status: 0, stdout: "a1\nb2\nc3\n" } })
    const hint = addressPoolExhaustionHint(RAW, run).join("\n")
    expect(hint).toContain("docker network prune")
    expect(hint).toContain("3 Supatype networks")
  })

  it("still gives the fix when Docker cannot list networks", () => {
    const { run } = fakeDocker({ "network ls": { status: 1 } })
    const hint = addressPoolExhaustionHint(RAW, run).join("\n")
    expect(hint).toContain("docker network prune")
    expect(hint).not.toContain("Supatype networks")
  })

  it("is empty for any other failure, and asks Docker nothing", () => {
    const { run, calls } = fakeDocker({})
    expect(addressPoolExhaustionHint("port is already allocated", run)).toEqual([])
    expect(calls).toEqual([])
  })

  it("with no captured output, probes by creating and removing a network", () => {
    const { run, calls } = fakeDocker({
      "network create": { status: 1, stderr: RAW },
      "network ls": { status: 0, stdout: "a1\n" },
    })
    expect(addressPoolExhaustionHint(null, run).join("\n")).toContain("1 Supatype network ")
    expect(calls.some((c) => c.startsWith("network rm"))).toBe(false)
  })

  it("removes the probe network when it could be created", () => {
    const { run, calls } = fakeDocker({ "network create": { status: 0 } })
    expect(addressPoolExhaustionHint(null, run)).toEqual([])
    expect(calls.filter((c) => c.startsWith("network rm"))).toHaveLength(1)
  })
})
