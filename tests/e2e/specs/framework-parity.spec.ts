import { expect, test, type Page, type TestInfo } from "@playwright/test"

/**
 * The framework-parity example: the same screen in Vue, Svelte and Solid, against one stack.
 *
 * Its README names the five things each app does: sign in, list tasks, add one, watch somebody
 * else's insert arrive, and call an edge function. A binding that compiles and then does one of
 * those differently from the other two is exactly what the example exists to catch, and nothing
 * ran it. So each app is driven through the same five steps, then signed out, and what each step
 * produced is recorded and compared: the three must agree, and agree with the server.
 *
 * Run by tests/integration/scripts/framework-parity-e2e.sh, which starts the stack, builds the three
 * apps and serves each one with `vite preview` on a port of its own.
 */

const FRAMEWORKS = ["vue", "svelte", "solid"] as const
type Framework = (typeof FRAMEWORKS)[number]

const API = process.env.PARITY_API_URL ?? "http://127.0.0.1:18473"
const ANON = process.env.ANON_KEY ?? ""
const PASSWORD = "parity-e2e-password"
// Set per run of the group, so a repeated run (`--repeat-each`) never meets its own earlier rows.
let RUN = ""

function appUrl(fw: Framework): string {
  const url = process.env[`PARITY_${fw.toUpperCase()}_URL`]
  if (url === undefined || url === "") throw new Error(`PARITY_${fw.toUpperCase()}_URL is not set`)
  return url
}

interface Account {
  email: string
  token: string
  id: string
}

/** What one app showed at each of the five steps, and after signing out. */
interface Outcome {
  signedInAs: string
  listedSeed: boolean
  ownInsertListed: boolean
  ownInsertOwner: string | null
  othersInsertArrived: boolean
  ping: string
  signedOut: boolean
}

const outcomes = new Map<Framework, Outcome>()

async function api(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${init.token ?? ANON}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 200)}`)
  return text === "" ? null : (JSON.parse(text) as unknown)
}

async function signUp(label: string): Promise<Account> {
  const email = `parity-${label}-${RUN}@example.com`
  const body = (await api("/auth/v1/signup", { method: "POST", body: { email, password: PASSWORD } })) as {
    access_token?: string
    user?: { id?: string }
  }
  if (body.access_token === undefined || body.user?.id === undefined) throw new Error(`sign-up for ${email} returned no session`)
  return { email, token: body.access_token, id: body.user.id }
}

async function insertTask(account: Account, title: string): Promise<void> {
  await api("/rest/v1/task", { method: "POST", token: account.token, body: { title, done: false } })
}

async function taskOwner(account: Account, title: string): Promise<string | null> {
  const rows = (await api(`/rest/v1/task?title=eq.${encodeURIComponent(title)}&select=auth_user_id`, {
    token: account.token,
  })) as { auth_user_id: string | null }[]
  return rows[0]?.auth_user_id ?? null
}

/**
 * Every realtime frame the page sends and receives, attached to the report when a test fails. A
 * realtime step that times out says only that a row never appeared; the frames say whether the
 * join was acknowledged and whether the insert was ever delivered.
 */
let frames: string[] = []
let joinedSignedIn = false

/** The role a realtime socket authenticated as, read from the token in its URL. */
function socketRole(url: string): string {
  const token = new URL(url).searchParams.get("token") ?? ""
  const payload = token.split(".")[1] ?? ""
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: string }).role ?? "none"
  } catch {
    return "none"
  }
}

function recordRealtime(page: Page): void {
  frames = []
  joinedSignedIn = false
  page.on("websocket", (ws) => {
    const role = socketRole(ws.url())
    const stamp = (dir: string, payload: string | Buffer): void => {
      frames.push(`${new Date().toISOString().slice(11, 23)} [${role}] ${dir} ${String(payload).slice(0, 300)}`)
    }
    stamp("open", "")
    ws.on("framesent", (f) => stamp(">", f.payload))
    ws.on("framereceived", (f) => {
      stamp("<", f.payload)
      if (role === "authenticated" && String(f.payload).includes("subscribed to public:task")) joinedSignedIn = true
    })
    ws.on("close", () => stamp("close", ""))
  })
}

async function reportRealtime(testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return
  const body = frames.join("\n")
  // Printed as well as attached: the train keeps the suite's output, not Playwright's report.
  console.log(`realtime frames for "${testInfo.title}":\n${body}`)
  await testInfo.attach("realtime-frames", { body, contentType: "text/plain" })
}

const listItem = (page: Page, title: string) => page.locator("ul.list li", { hasText: title })

async function signIn(page: Page, fw: Framework, account: Account): Promise<string> {
  await page.goto(appUrl(fw))
  await expect(page.getByRole("heading", { level: 1 })).toContainText(new RegExp(fw, "i"))
  await page.getByPlaceholder("email").fill(account.email)
  await page.getByPlaceholder("password").fill(PASSWORD)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const status = page.locator("p.muted", { hasText: "socket" })
  await expect(status).toContainText(account.email)
  // The subscription is what step four depends on; an insert made before it joined is one it
  // was never going to see, and that would be a broken test rather than a broken binding.
  await expect(status).toContainText("socket connected")
  // And joined as the user who signed in. The socket opened on page load is anon, the client
  // reopens it with the user's token on sign-in, and the status above still reads "connected"
  // from the first one while that happens. Only the signed-in socket can deliver a task.
  await expect.poll(() => joinedSignedIn, { message: "the realtime channel never joined as the signed-in user" }).toBe(true)
  return (await status.textContent())?.split("·")[0]?.trim() ?? ""
}

async function addOwnTask(page: Page, title: string): Promise<boolean> {
  await page.getByPlaceholder("What needs doing?").fill(title)
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await expect(listItem(page, title)).toBeVisible()
  return true
}

async function callPing(page: Page): Promise<string> {
  await page.getByRole("button", { name: "call ping" }).click()
  const result = page.locator("span.muted", { hasText: "→" })
  await expect(result).toBeVisible()
  return (await result.textContent())?.replace("→", "").trim() ?? ""
}

async function signOut(page: Page): Promise<boolean> {
  await page.getByRole("button", { name: "sign out" }).click()
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
  return true
}

test.describe.serial("framework parity: the same five steps in Vue, Svelte and Solid", () => {
  let other: Account
  let seed = ""

  test.beforeAll(async () => {
    if (ANON === "") throw new Error("ANON_KEY must be set")
    RUN = `${Date.now()}`
    seed = `seed task ${RUN}`
    // Somebody else, whose rows every signed-in user may read (`read: LoggedIn`).
    other = await signUp("other")
    await insertTask(other, seed)
  })

  test.afterEach(async ({}, testInfo) => reportRealtime(testInfo))

  for (const fw of FRAMEWORKS) {
    test(`${fw}: sign in, list, add, watch an insert arrive, call a function, sign out`, async ({ page }) => {
      recordRealtime(page)
      const me = await signUp(fw)

      const signedInAs = await signIn(page, fw, me)
      await expect(listItem(page, seed)).toBeVisible()

      const mine = `${fw} adds ${RUN}`
      const ownInsertListed = await addOwnTask(page, mine)

      // Inserted by another user, outside this page: only the subscription can bring it here.
      const theirs = `${fw} sees other ${RUN}`
      await insertTask(other, theirs)
      await expect(listItem(page, theirs)).toBeVisible()

      const ping = await callPing(page)
      const signedOut = await signOut(page)

      outcomes.set(fw, {
        signedInAs: signedInAs === me.email ? "<the user who signed in>" : signedInAs,
        listedSeed: true,
        ownInsertListed,
        ownInsertOwner: (await taskOwner(me, mine)) === me.id ? "<the user who added it>" : "someone else",
        othersInsertArrived: true,
        ping,
        signedOut,
      })
    })
  }

  test("the three apps produced the same result at every step", () => {
    expect([...outcomes.keys()]).toEqual([...FRAMEWORKS])
    const [first, ...rest] = FRAMEWORKS.map((fw) => outcomes.get(fw))
    for (const outcome of rest) expect(outcome).toEqual(first)
    // And the result they agree on is the right one, not three copies of the same mistake.
    expect(first).toEqual({
      signedInAs: "<the user who signed in>",
      listedSeed: true,
      ownInsertListed: true,
      ownInsertOwner: "<the user who added it>",
      othersInsertArrived: true,
      ping: JSON.stringify({ ok: true, from: "ping" }),
      signedOut: true,
    })
  })
})
