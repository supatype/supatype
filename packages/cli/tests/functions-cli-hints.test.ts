import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isArrayOf, isJsonObject, isShape, isString, optional } from "@supatype/shared"
import { runCommand, tempProject } from "./support/command-run.js"

let fakeHome = ""

// Cloud credentials live under the home directory; every test gets its own.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => (fakeHome.length > 0 ? fakeHome : actual.homedir()) }
})

import { registerFunctions } from "../src/commands/functions.js"

/**
 * What `supatype functions` tells someone to run next has to be a command that exists.
 *
 * It named `supatype self-host compose restart` before that subcommand existed, then a raw
 * `docker compose ... restart` after it did, and `npx supatype cloud login` / `cloud link`, which
 * are `supatype login` and `supatype link`. It also
 * looked for a session in `~/.supatype/token`, a file nothing writes, so a user who had just run
 * `supatype login` was told they were not logged in.
 */
let project: { dir: string; remove: () => void }

/** A functions deploy body, as far as the tests read it. */
const isDeployBody = isShape({ functions: isArrayOf(isShape({ name: isString, files: optional(isJsonObject) })) })

function writeConfig(dir: string): void {
  writeFileSync(
    join(dir, "supatype.config.ts"),
    `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" } }\n`,
  )
}

function writeFunction(dir: string): void {
  mkdirSync(join(dir, "functions", "hello"), { recursive: true })
  writeFileSync(join(dir, "functions", "hello", "index.ts"), "export default () => new Response('hi')\n")
}

function linkToCloud(dir: string): void {
  mkdirSync(join(dir, ".supatype"), { recursive: true })
  const link = {
    version: 1,
    kind: "cloud",
    projectRef: "acme-ref",
    defaultEnvironment: "production",
    cloudApiUrl: "https://api.example.test",
    environments: { production: { name: "production", apiUrl: "https://api.example.test", linkedAt: "2026-01-01T00:00:00Z" } },
  }
  writeFileSync(join(dir, ".supatype", "link.json"), JSON.stringify(link))
}

beforeEach(() => {
  project = tempProject("functions-hints")
  fakeHome = join(project.dir, "home")
  mkdirSync(join(fakeHome, ".supatype"), { recursive: true })
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", undefined)
  vi.stubEnv("SUPATYPE_TOKEN", undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  project.remove()
  fakeHome = ""
})

describe("functions deploy on a self-host compose stack", () => {
  it("tells you a restart command that exists", async () => {
    writeConfig(project.dir)
    writeFunction(project.dir)
    mkdirSync(join(project.dir, ".supatype", "self-host"), { recursive: true })
    writeFileSync(join(project.dir, ".supatype", "self-host", "docker-compose.yml"), "services: {}\n")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    // The CLI's own command, which recreates the service with the current config and .env.
    expect(run.output).toContain("supatype self-host compose restart functions-worker")
    expect(run.output).not.toContain("docker compose -p")
  })

  it("names the directory functions.path points at, not a fixed functions/", async () => {
    writeFileSync(
      join(project.dir, "supatype.config.ts"),
      `export default { project: { name: "acme" }, database: { provider: "docker" }, server: { mode: "dev" }, app: { mode: "none" }, functions: { path: "api/edge" } }\n`,
    )
    mkdirSync(join(project.dir, "api", "edge", "hello"), { recursive: true })
    writeFileSync(join(project.dir, "api", "edge", "hello", "index.ts"), "export default () => new Response('hi')\n")
    mkdirSync(join(project.dir, ".supatype", "self-host"), { recursive: true })
    writeFileSync(join(project.dir, ".supatype", "self-host", "docker-compose.yml"), "services: {}\n")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(run.output).toMatch(/Functions are served from api[\\/]edge\/ in your project/)
    expect(run.output).not.toContain("functions/ directory")
  })
})

describe("functions commands against a cloud link", () => {
  it("names supatype login, not a cloud subcommand that does not exist", async () => {
    writeConfig(project.dir)
    linkToCloud(project.dir)
    const run = await runCommand(registerFunctions, ["functions", "list"], project.dir)

    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("Run: supatype login")
    expect(run.output).not.toContain("cloud login")
  })

  it("uses the session supatype login saved", async () => {
    writeConfig(project.dir)
    linkToCloud(project.dir)
    writeFileSync(
      join(fakeHome, ".supatype", "credentials.json"),
      JSON.stringify({ apiUrl: "https://api.example.test", accessToken: "saved-by-login" }),
    )
    const seen: string[] = []
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization") ?? "")
      return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } })
    })

    const run = await runCommand(registerFunctions, ["functions", "list"], project.dir)

    expect(run.output).not.toContain("Not logged in")
    expect(seen).toEqual(["Bearer saved-by-login"])
  })

  // Review of round 7: `supatype link` and the cloud commands take SUPATYPE_TOKEN, the older name,
  // but a linked project's commands read only SUPATYPE_ACCESS_TOKEN and said "Not logged in".
  it("uses a token exported as SUPATYPE_TOKEN", async () => {
    writeConfig(project.dir)
    linkToCloud(project.dir)
    vi.stubEnv("SUPATYPE_TOKEN", "from-the-older-name")
    const seen: string[] = []
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization") ?? "")
      return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } })
    })

    const run = await runCommand(registerFunctions, ["functions", "list"], project.dir)

    expect(run.output).not.toContain("Not logged in")
    expect(seen).toEqual(["Bearer from-the-older-name"])
  })

  it("names supatype link when the project is not linked", async () => {
    writeFunction(project.dir)
    const run = await runCommand(registerFunctions, ["functions", "delete", "hello"], project.dir)

    expect(run.output).toContain("No linked project. Run: supatype link")
    expect(run.output).not.toContain("cloud link")
  })
})

// Local test round 3c (N17): every function failed, and deploy still said `Deployed 1 function(s)`,
// printed the invoke URL and exited 0.
describe("functions deploy to Cloud when a function fails", () => {
  function linkAndLogIn(): void {
    writeConfig(project.dir)
    writeFunction(project.dir)
    mkdirSync(join(project.dir, "functions", "bye"), { recursive: true })
    writeFileSync(join(project.dir, "functions", "bye", "index.ts"), "export default () => new Response('bye')\n")
    linkToCloud(project.dir)
    vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "token")
  }

  function platformRefusing(name: string): void {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "")
      if (body.includes(`"name":"${name}"`)) {
        return new Response(JSON.stringify({ error: "bundle too large" }), { status: 422 })
      }
      return new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } })
    })
  }

  // Review B4: one request carries every function, so the worker restarts once a deploy; a refusal
  // of that request fails every function it carried.
  it("sends every function in one request", async () => {
    linkAndLogIn()
    const bodies: string[] = []
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""))
      return new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } })
    })

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(`"name":"hello"`)
    expect(bodies[0]).toContain(`"name":"bye"`)
    expect(run.output).toContain("Deployed 2 function(s)")
  })

  // Round 6 N27: a directory function went as a JSON map of its files in `source`, which a
  // self-hosted control plane wrote as its index.ts, over the project's own checkout.
  it("sends a function's entry as its source, and every file it has by path", async () => {
    linkAndLogIn()
    mkdirSync(join(project.dir, "functions", "hello", "lib"), { recursive: true })
    writeFileSync(join(project.dir, "functions", "hello", "lib", "greet.ts"), "export const greet = 'hi'\n")
    const bodies: unknown[] = []
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "null")))
      return new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } })
    })

    await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(bodies[0]).toMatchObject({
      functions: [
        { name: "bye", source: "export default () => new Response('bye')\n" },
        {
          name: "hello",
          entrypoint: "hello/index.ts",
          source: "export default () => new Response('hi')\n",
          files: { "index.ts": "export default () => new Response('hi')\n", "lib/greet.ts": "export const greet = 'hi'\n" },
        },
      ],
    })
  })

  // Review of round 7: only .ts and .js files went, so a function importing its JSON or an .mjs
  // module deployed without them, while the worker loads both. One rule decides for both now.
  it("sends every file the worker loads, and no dotfile or other file", async () => {
    linkAndLogIn()
    const dir = join(project.dir, "functions", "hello")
    writeFileSync(join(dir, "data.json"), '{"greeting":"hi"}\n')
    writeFileSync(join(dir, "util.mjs"), "export const n = 1\n")
    writeFileSync(join(dir, "README.md"), "notes\n")
    writeFileSync(join(dir, ".env.local"), "SECRET=1\n")
    const bodies: unknown[] = []
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "null")))
      return new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } })
    })

    await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    const body = bodies[0]
    if (!isDeployBody(body)) throw new Error(`not a deploy body: ${JSON.stringify(body)}`)
    const hello = body.functions.find((fn) => fn.name === "hello")
    expect(Object.keys(hello?.files ?? {}).sort()).toEqual(["data.json", "index.ts", "util.mjs"])
  })

  it("says the warning a self-hosted stack answers with, and still deploys", async () => {
    linkAndLogIn()
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ data: { warning: "Docker could not be asked whether the functions worker is running: down" } }), {
        headers: { "Content-Type": "application/json" },
      }),
    )

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(run.output).toContain("Docker could not be asked whether the functions worker is running: down")
    expect(run.output).toContain("Deployed 2 function(s)")
    expect(run.exitCode ?? 0).toBe(0)
  })

  it("names every function the refused request carried, and exits non-zero", async () => {
    linkAndLogIn()
    platformRefusing("bye")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(run.output).toContain("bye ✗ HTTP 422: bundle too large")
    expect(run.output).toContain("hello ✗ HTTP 422: bundle too large")
    expect(run.output).toContain("2 of 2 function(s) failed to deploy: bye, hello")
    expect(run.output).not.toContain("Deployed 2 function(s)")
    expect(run.exitCode).toBe(1)
  })

  // Review of round 3c: a failed deploy through the linked target ended with process.exit inside the
  // try that falls back to the other paths, so where exit throws it deployed everything again.
  it("ends a failed deploy through the linked target, without deploying again another way", async () => {
    linkAndLogIn()
    writeFileSync(join(fakeHome, ".supatype", "credentials.json"), JSON.stringify({ apiUrl: "https://api.example.test", accessToken: "saved" }))
    platformRefusing("bye")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(run.output).toContain("Deploying to cloud project: acme-ref")
    expect(run.output).toContain("2 of 2 function(s) failed to deploy: bye, hello")
    expect(run.output).not.toContain("Deploying to project: acme-ref")
    expect(run.exitCode).toBe(1)
  })

  // Review of round 3c: the config was loaded once per function, so a broken one failed each in turn.
  it("reads the service-role list once, and stops at a broken config before sending anything", async () => {
    linkAndLogIn()
    const sent: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      sent.push(url)
      return new Response("{}", { headers: { "Content-Type": "application/json" } })
    })
    writeFileSync(join(project.dir, "supatype.config.ts"), "export default {{ broken\n")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir).catch((err: unknown) => ({ output: String(err), exitCode: 1 }))

    expect(sent).toEqual([])
    expect(run.output).not.toContain("hello ✗")
    expect(run.output).not.toContain("bye ✗")
  })

  it("says every function deployed and exits 0 when none failed", async () => {
    linkAndLogIn()
    platformRefusing("none")

    const run = await runCommand(registerFunctions, ["functions", "deploy"], project.dir)

    expect(run.output).toContain("Deployed 2 function(s)")
    expect(run.exitCode ?? 0).toBe(0)
  })
})

// Review of round 5: invoke ended with "Run: supatype login" on a Cloud link with no session,
// though invoking a public function needs none, and it used to work.
describe("functions invoke on a Cloud link with no session", () => {
  function invokedWith(): { url: string; auth: string | null }[] {
    const seen: { url: string; auth: string | null }[] = []
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization") })
      return new Response("{}", { status: 200 })
    })
    return seen
  }

  it("calls the function without a token", async () => {
    writeConfig(project.dir)
    linkToCloud(project.dir)
    const seen = invokedWith()
    const run = await runCommand(registerFunctions, ["functions", "invoke", "hello"], project.dir)
    expect(run.exitCode).toBeUndefined()
    expect(seen).toEqual([{ url: "https://acme-ref.supatype.dev/functions/v1/hello", auth: null }])
  })

  it("asks for a login when --auth wants a token, sending nothing", async () => {
    writeConfig(project.dir)
    linkToCloud(project.dir)
    const seen = invokedWith()
    const run = await runCommand(registerFunctions, ["functions", "invoke", "hello", "--auth"], project.dir)
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("supatype login")
    expect(seen).toEqual([])
  })
})

// Review of round 5: a deploy sends every function in one request, and Supatype Cloud syncs them in
// turn, so one 60 s limit timed a large deploy out, reporting every function failed while the
// server deployed them.
describe("a deploy of several functions in one request", () => {
  it("waits longer for each function it carries", async () => {
    writeConfig(project.dir)
    writeFunction(project.dir)
    mkdirSync(join(project.dir, "functions", "bye"), { recursive: true })
    writeFileSync(join(project.dir, "functions", "bye", "index.ts"), "export default () => new Response('bye')\n")
    linkToCloud(project.dir)
    vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "token")
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } }))
    const asked: number[] = []
    const real = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      asked.push(ms)
      return real(ms)
    })
    await runCommand(registerFunctions, ["functions", "deploy"], project.dir)
    vi.restoreAllMocks()
    expect(asked).toEqual([60_000 + 2 * 30_000])
  })
})
