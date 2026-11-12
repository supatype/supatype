import { describe, expect, it } from "vitest"
import { MessageOrder } from "../src/message-order.js"

/** A task that records when it ran and finishes only when released. */
function gated(log: string[], name: string): { task: () => Promise<void>; release: () => void } {
  let release = (): void => {}
  const done = new Promise<void>((resolve) => { release = resolve })
  return {
    task: async () => {
      log.push(`${name} start`)
      await done
      log.push(`${name} end`)
    },
    release,
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("the order a client's frames are handled in", () => {
  it("runs one channel's frames one after another", async () => {
    const log: string[] = []
    const order = new MessageOrder(() => {})
    const join = gated(log, "join a")
    order.run("a", join.task)
    order.run("a", async () => { log.push("leave a") })
    await flush()
    expect(log).toEqual(["join a start"])
    join.release()
    await flush()
    expect(log).toEqual(["join a start", "join a end", "leave a"])
  })

  it("does not hold one channel's frames behind another's", async () => {
    const log: string[] = []
    const order = new MessageOrder(() => {})
    const join = gated(log, "join a")
    order.run("a", join.task)
    order.run("b", async () => { log.push("broadcast b") })
    await flush()
    expect(log).toEqual(["join a start", "broadcast b"])
    join.release()
  })

  it("runs a frame naming no channel after every earlier frame, and every later one after it", async () => {
    const log: string[] = []
    const order = new MessageOrder(() => {})
    const join = gated(log, "join a")
    order.run("a", join.task)
    order.run(null, async () => { log.push("auth") })
    order.run("b", async () => { log.push("join b") })
    await flush()
    expect(log).toEqual(["join a start"])
    join.release()
    await flush()
    expect(log).toEqual(["join a start", "join a end", "auth", "join b"])
  })

  it("reports a frame that fails and carries on with the next", async () => {
    const errors: unknown[] = []
    const log: string[] = []
    const order = new MessageOrder((err) => errors.push(err))
    order.run("a", async () => { throw new Error("boom") })
    order.run("a", async () => { log.push("next") })
    await flush()
    expect(errors).toHaveLength(1)
    expect(log).toEqual(["next"])
  })
})
