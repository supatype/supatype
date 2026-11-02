import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { tempProject } from "./support/command-run.js"

/**
 * Local test round 4 (N21, security): interactive `supatype link` to a self-host URL, on a machine
 * where someone had logged in to Cloud, sent that Cloud access token to the self-host server, and
 * never read `.env`'s SERVICE_ROLE_KEY or asked for a key. A self-host link uses `--token`, then
 * `.env`'s SERVICE_ROLE_KEY, then asks.
 */
const CLOUD_TOKEN = "cloud-access-token-from-login"
const SELF_HOST_URL = "http://selfhost.example.test"
const answers = vi.hoisted(() => ({ password: "", asked: 0 }))

vi.mock("../src/cloud-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cloud-credentials.js")>()),
  loadCloudCredentials: () => ({ apiUrl: "https://api.supatype.com", accessToken: CLOUD_TOKEN }),
}))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => true }))
vi.mock("../src/ui/prompts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/prompts.js")>()
  return {
    ...actual,
    runClackFlow: async (run: () => Promise<unknown>) => run(),
    p: {
      ...actual.p,
      intro: () => undefined,
      outro: () => undefined,
      select: async () => "self-host",
      text: async () => SELF_HOST_URL,
      password: async () => {
        answers.asked++
        return answers.password
      },
    },
  }
})

const { runLinkAction } = await import("../src/commands/link-helpers.js")
let project: { dir: string; remove: () => void }
let sent: { url: string; authorization: string }[] = []

beforeEach(() => {
  project = tempProject("link-self-host-token")
  scaffold(project.dir, defaultScaffoldOptions("lk"))
  vi.spyOn(process, "cwd").mockReturnValue(project.dir)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", undefined)
  vi.stubEnv("SUPATYPE_TOKEN", undefined)
  vi.stubEnv("SERVICE_ROLE_KEY", undefined)
  answers.password = ""
  answers.asked = 0
  sent = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") ?? "" })
    return Response.json({})
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  project.remove()
})

describe("supatype link to self-host", () => {
  it("sends .env's SERVICE_ROLE_KEY, never the Cloud login's token", async () => {
    appendFileSync(join(project.dir, ".env"), "\nSERVICE_ROLE_KEY=env-service-role-key\n")
    await runLinkAction({ apiUrl: "https://api.supatype.com" })
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((call) => call.url.startsWith(SELF_HOST_URL))).toBe(true)
    expect(sent.map((call) => call.authorization)).not.toContain(`Bearer ${CLOUD_TOKEN}`)
    expect(sent[0]?.authorization).toBe("Bearer env-service-role-key")
    expect(answers.asked).toBe(0)
  })

  it("asks for the key, hidden, when .env has none", async () => {
    answers.password = "typed-service-role-key"
    await runLinkAction({ apiUrl: "https://api.supatype.com" })
    expect(answers.asked).toBe(1)
    expect(sent[0]?.authorization).toBe("Bearer typed-service-role-key")
  })

  it("takes --token ahead of .env", async () => {
    appendFileSync(join(project.dir, ".env"), "\nSERVICE_ROLE_KEY=env-service-role-key\n")
    await runLinkAction({ apiUrl: "https://api.supatype.com", url: SELF_HOST_URL, token: "flag-key" })
    expect(sent[0]?.authorization).toBe("Bearer flag-key")
  })
})
