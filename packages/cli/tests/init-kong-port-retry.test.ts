import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Issue 52: init asked for the Kong port, said it was taken, and when the port typed at "Enter a
 * different port" was still taken it ended init, every answer so far lost. It asks again now.
 *
 * The port was not even listening: an exited container of another project had it in its bindings.
 * Docker reserves a port only for a running container, so a port only a stopped stack is configured
 * with is the person's to choose, with a warning that the two stacks cannot run at once. Init still
 * never offers one by itself.
 */

const listening = new Set<number>()
vi.mock("../src/postgres-ctl.js", () => ({ isPortInUse: vi.fn(async (port: number) => listening.has(port)) }))

const typed: string[] = []
const chosen: string[] = []
const texts: string[] = []
const selects: string[] = []
const warnings: string[] = []
const confirms: string[] = []
const confirmed: boolean[] = []
vi.mock("../src/ui/clack.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/clack.js")>()
  const next = (queue: string[], what: string): string => {
    const answer = queue.shift()
    if (answer === undefined) throw new Error(`no answer left for ${what}`)
    return answer
  }
  return {
    ...actual,
    p: {
      ...actual.p,
      text: async ({ message }: { message: string }) => {
        texts.push(message)
        return next(typed, message)
      },
      select: async ({ message }: { message: string }) => {
        selects.push(message)
        return next(chosen, message)
      },
      confirm: async ({ message }: { message: string }) => {
        confirms.push(message)
        const answer = confirmed.shift()
        if (answer === undefined) throw new Error(`no answer left for ${message}`)
        return answer
      },
      log: { ...actual.p.log, warn: (message: string) => warnings.push(message), info: () => {} },
    },
  }
})
vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string): never => {
    throw new Error(`init ended: ${message}`)
  },
}))

const { promptKongPortChoice } = await import("../src/dev-ports.js")
type Reader = NonNullable<Parameters<typeof promptKongPortChoice>[0]>

/** Docker with one exited container of another Supatype project, configured to publish 18500. */
const STOPPED_STACK_ON_18500: Reader = {
  listContainers: async () => "a1 supatype-kitchen-sink\n",
  portBindings: async () => '{"8000/tcp":[{"HostIp":"","HostPort":"18500"}]}\n',
}

beforeEach(() => {
  vi.stubEnv("SUPATYPE_KONG_PORT", undefined)
  for (const list of [typed, chosen, texts, selects, warnings, confirms, confirmed]) list.length = 0
  listening.clear()
})
afterEach(() => vi.unstubAllEnvs())

// Issue 59: a warning logged between two prompts was wiped when the wizard redrew, so each reason
// is now part of the prompt that follows it.
describe("init's Kong port prompt", () => {
  it("asks again when the different port typed is still in use, saying why in the question", async () => {
    listening.add(18480)
    typed.push("18480", "18480", "18490")
    chosen.push("custom")
    expect(await promptKongPortChoice(STOPPED_STACK_ON_18500, {})).toBe(18490)
    expect(texts).toHaveLength(3)
    expect(texts[1]).toBe("Local API gateway port (Kong)")
    expect(texts[2]).toMatch(/^Port 18480 is in use on this machine\. Pick another port.*\nLocal API gateway port \(Kong\)$/s)
    expect(warnings).toEqual([])
  })

  it("says only what is true of a port that is listening", async () => {
    listening.add(18480)
    typed.push("18480", "18490")
    chosen.push("custom")
    await promptKongPortChoice(STOPPED_STACK_ON_18500, {})
    expect(selects).toEqual(["Port 18480 is in use on this machine."])
  })

  it("asks before taking a port only a stopped stack is configured with", async () => {
    typed.push("18500")
    confirmed.push(true)
    expect(await promptKongPortChoice(STOPPED_STACK_ON_18500, {})).toBe(18500)
    expect(selects).toEqual([])
    expect(confirms).toHaveLength(1)
    expect(confirms[0]).toMatch(/18500 is configured for another Supatype stack.*cannot run at once.*Use 18500 anyway\?/s)
    expect(warnings).toEqual([])
  })

  it("asks for another port, saying why, when that port is declined", async () => {
    typed.push("18500", "18490")
    confirmed.push(false)
    expect(await promptKongPortChoice(STOPPED_STACK_ON_18500, {})).toBe(18490)
    expect(texts[1]).toMatch(/^Pick a port no other Supatype stack is configured with\.\nLocal API gateway port/)
  })

  it("asks about that port at 'Enter a different port' too", async () => {
    listening.add(18480)
    typed.push("18480", "18500")
    chosen.push("custom")
    confirmed.push(true)
    expect(await promptKongPortChoice(STOPPED_STACK_ON_18500, {})).toBe(18500)
    expect(confirms[0]).toMatch(/18500 is configured for another Supatype stack/)
  })
})
