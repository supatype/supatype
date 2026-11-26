import { existsSync } from "node:fs"
import { hostname } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerLogin } from "../src/commands/login.js"
import { clearCloudCredentials, credentialsPath, loadCloudCredentials, saveCloudCredentials } from "../src/cloud-credentials.js"
import { FakeCliLoginServer, loginUrlFrom } from "./support/fake-cli-login-server.js"
import { runCommand, tempProject, type CommandRun } from "./support/command-run.js"

/** What the terminal does: the codes the user types, and what happens in the browser before each. */
const terminal = vi.hoisted(() => ({
  answers: [] as string[],
  asked: 0,
  beforeAnswer: undefined as undefined | ((ask: number) => void),
  interactive: true,
}))
const opened = vi.hoisted(() => ({ urls: [] as string[] }))

vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => terminal.interactive }))
vi.mock("../src/open-browser.js", () => ({ openBrowser: async (url: string) => opened.urls.push(url) > 0 }))
vi.mock("../src/ui/prompts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/prompts.js")>()),
  promptText: async () => {
    terminal.beforeAnswer?.(terminal.asked)
    return terminal.answers[terminal.asked++] ?? ""
  },
}))

let server: FakeCliLoginServer
let apiUrl: string
let project: ReturnType<typeof tempProject>

beforeEach(async () => {
  server = new FakeCliLoginServer()
  apiUrl = await server.listen()
  project = tempProject("cli-login")
  clearCloudCredentials()
  Object.assign(terminal, { answers: [], asked: 0, beforeAnswer: undefined, interactive: true })
  opened.urls.length = 0
  vi.stubEnv("SUPATYPE_ACCOUNTS_URL", "")
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await server.close()
  project.remove()
})

/** The user approves in the browser when the CLI first asks for the code, from the URL it printed. */
function approveWhenAsked(): void {
  terminal.beforeAnswer = (ask) => {
    if (ask === 0) server.approve(loginUrlFrom(printedSoFar()).login)
  }
}

/** What the running command has logged, which `runCommand` is capturing. */
function printedSoFar(): string {
  return vi.mocked(console.log).mock.calls.map((call) => call.map(String).join(" ")).join("\n")
}

function login(args: string[]): Promise<CommandRun> {
  return runCommand(registerLogin, ["login", "--api-url", apiUrl, ...args], project.dir)
}

describe("supatype login in the browser", () => {
  it("opens and prints the accounts URL, decrypts the PAT with the typed code and saves it", async () => {
    terminal.answers = ["ABCD-2345"]
    approveWhenAsked()
    const run = await login(["--name", "my-laptop"])
    expect(run.exitCode).toBeUndefined()
    const { url, login: sent } = loginUrlFrom(run.output)
    expect(url.origin + url.pathname).toBe("http://accounts.example.test/cli/login")
    expect(sent.tokenName).toBe("my-laptop")
    expect(sent.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sent.publicKey).toMatch(/^04[0-9a-f]{128}$/)
    expect(opened.urls).toEqual([url.href])
    expect(loadCloudCredentials()).toMatchObject({ apiUrl, accessToken: server.pat, email: server.email })
    expect(loadCloudCredentials()?.refreshToken).toBeUndefined()
    expect(run.output).toContain(`Logged in to ${apiUrl} as ${server.email}`)
    expect(server.meAuthorization).toEqual([`Bearer ${server.pat}`])
  })

  it("names the token cli_<hostname>_<unix seconds> by default", async () => {
    terminal.answers = ["ABCD2345"]
    approveWhenAsked()
    const before = Math.floor(Date.now() / 1000)
    const run = await login([])
    const name = loginUrlFrom(run.output).login.tokenName
    const prefix = `cli_${hostname()}_`
    expect(name.startsWith(prefix)).toBe(true)
    expect(Number(name.slice(prefix.length))).toBeGreaterThanOrEqual(before)
  })

  it("asks again after a wrong code, tells the user it was not accepted, and takes the right one", async () => {
    terminal.answers = ["WXYZ-9999", "abcd-2345"]
    approveWhenAsked()
    const run = await login([])
    expect(run.exitCode).toBeUndefined()
    expect(server.codesTried).toEqual(["WXYZ-9999", "abcd-2345"])
    expect(run.output).toMatch(/code was not accepted/i)
    expect(loadCloudCredentials()?.accessToken).toBe(server.pat)
  })

  it("gives up with a clear error when the login has expired, and saves nothing", async () => {
    terminal.answers = Array.from({ length: 5 }, () => "ABCD-2345")
    const run = await login([])
    expect(run.exitCode).toBe(1)
    expect(run.output).toMatch(/expired/i)
    expect(terminal.asked).toBeGreaterThan(1)
    expect(existsSync(credentialsPath())).toBe(false)
  })

  it("with --no-browser prints the URL and opens nothing", async () => {
    terminal.answers = ["ABCD-2345"]
    approveWhenAsked()
    const run = await login(["--no-browser"])
    expect(run.exitCode).toBeUndefined()
    expect(opened.urls).toEqual([])
    expect(loginUrlFrom(run.output).url.pathname).toBe("/cli/login")
  })

  it("refuses to wait for a code without a terminal, and says to use --token", async () => {
    terminal.interactive = false
    const run = await login([])
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("--token")
  })

  it("takes SUPATYPE_ACCOUNTS_URL over the control plane's answer, and does not ask it", async () => {
    vi.stubEnv("SUPATYPE_ACCOUNTS_URL", "http://env-accounts.test/")
    terminal.answers = ["ABCD-2345"]
    approveWhenAsked()
    const run = await login([])
    expect(loginUrlFrom(run.output).url.origin).toBe("http://env-accounts.test")
    expect(server.configAsks).toBe(0)
  })

  it("asks the control plane where the accounts site is, with no guess from the API URL", async () => {
    server.accountsUrl = "http://accounts.elsewhere.test/"
    terminal.answers = ["ABCD-2345"]
    approveWhenAsked()
    const run = await login([])
    expect(loginUrlFrom(run.output).url.origin).toBe("http://accounts.elsewhere.test")
    expect(server.configAsks).toBe(1)
  })
})

describe("supatype login when the accounts site cannot be found", () => {
  const cases: Array<[string, () => void]> = [
    ["the control plane refuses the config request", () => { server.configStatus = 500 }],
    ["the answer is not a URL", () => { server.accountsUrl = "not a url" }],
    ["the answer is not http or https", () => { server.accountsUrl = "ftp://accounts.example.test" }],
    ["the answer has no accounts_url", () => { server.accountsUrl = undefined }],
  ]
  it.each(cases)("stops, naming the API URL and SUPATYPE_ACCOUNTS_URL, when %s", async (_, setUp) => {
    setUp()
    const run = await login([])
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain(apiUrl)
    expect(run.output).toContain("SUPATYPE_ACCOUNTS_URL")
    expect(opened.urls).toEqual([])
    expect(terminal.asked).toBe(0)
    expect(existsSync(credentialsPath())).toBe(false)
  })
})

describe("supatype login when the control plane refuses the code exchange", () => {
  it("explains a captcha_failed refusal: browser only, with the --token route for CI, and exits 1", async () => {
    server.exchangeReply = {
      status: 400,
      body: { code: 400, error_code: "captcha_failed", msg: "captcha protection: request disallowed (no captcha_token found)" },
    }
    terminal.answers = ["ABCD-2345"]
    const run = await login([])
    expect(run.exitCode).toBe(1)
    expect(run.output).toMatch(/only accepts sign-in through the browser/i)
    expect(run.output).toContain("supatype login")
    expect(run.output).toContain("--token")
    expect(run.output).toContain("SUPATYPE_ACCESS_TOKEN")
    expect(existsSync(credentialsPath())).toBe(false)
  })

  it("prints the server's own message for any other refusal, and exits 1", async () => {
    server.exchangeReply = { status: 500, body: { error: "login store unavailable" } }
    terminal.answers = ["ABCD-2345"]
    const run = await login([])
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("500")
    expect(run.output).toContain("login store unavailable")
    expect(existsSync(credentialsPath())).toBe(false)
  })

  it("prints the server's message when the accounts site lookup is refused", async () => {
    server.configStatus = 503
    const run = await login([])
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("nope")
  })
})

describe("supatype login --token", () => {
  it("saves a personal access token without opening a browser or asking for a code", async () => {
    const run = await login(["--token", server.pat])
    expect(run.exitCode).toBeUndefined()
    expect(terminal.asked).toBe(0)
    expect(opened.urls).toEqual([])
    expect(loadCloudCredentials()).toMatchObject({ apiUrl, accessToken: server.pat, email: server.email })
    expect(run.output).toContain(`as ${server.email}`)
  })

  it("replaces an old session, refresh token included", async () => {
    saveCloudCredentials({ version: 1, apiUrl, accessToken: "old-jwt", refreshToken: "old-refresh", updatedAt: "" })
    await login(["--token", server.pat])
    expect(loadCloudCredentials()?.refreshToken).toBeUndefined()
    expect(loadCloudCredentials()?.accessToken).toBe(server.pat)
  })

  it("refuses a value that is not a personal access token", async () => {
    const run = await login(["--token", "eyJhbGciOi.jwt"])
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("spt_")
    expect(existsSync(credentialsPath())).toBe(false)
  })

  it("does not save a token the control plane rejects", async () => {
    const run = await login(["--token", `spt_${"0".repeat(40)}`])
    expect(run.exitCode).toBe(1)
    expect(existsSync(credentialsPath())).toBe(false)
  })
})
