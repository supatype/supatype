/**
 * The Realtime Inspector on a running self-host stack (Phase-08 Appendix A, 8.3).
 *
 * Drives the masking project's stack (`tests/e2e/masking/project`, `employee.salary` readable by the
 * app role `admin`, `ssn` by its owner), brought up with `supatype dev`, with the dev Studio bypass
 * off (`STUDIO_OPEN_DEV=0` in its `.env`) so Studio roles apply:
 *
 *   MASKING_PROJECT_NAME=<name> SUPATYPE_KONG_PORT=<port> REALTIME_INSPECTOR_E2E=1 \
 *     E2E_BASE_URL=http://localhost:<port> pnpm exec playwright test specs/realtime-inspector.spec.ts
 *
 * Skipped without REALTIME_INSPECTOR_E2E: the rest of tests/e2e runs against a different stack.
 */
import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createClient } from "@supatype/client"
import { sql, stack } from "../masking/lib/stack.js"
import { signInToStudio } from "../lib/studio-session.js"

test.skip(process.env["REALTIME_INSPECTOR_E2E"] !== "1", "needs the masking project's stack, see the header")

const PASSWORD = "Correct-Horse-9"
const RUN = Date.now().toString(36)

interface Account {
  id: string
  email: string
  token: string
}

interface World {
  owner: Account
  developer: Account
  editor: Account
  admin: Account
  ref: string
}

let world: World

async function api(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${stack().baseUrl}${path}`, {
    method,
    headers: { apikey: stack().anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

async function account(name: string): Promise<Account> {
  const email = `rti-${name}-${RUN}@example.test`
  const created = await fetch(`${stack().baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: stack().serviceKey, Authorization: `Bearer ${stack().serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  })
  expect(created.status, `create ${name}`).toBeLessThan(300)
  const signedIn = await api("POST", "/auth/v1/token?grant_type=password", stack().anonKey, { email, password: PASSWORD })
  const session = (await signedIn.json()) as { access_token: string; user: { id: string } }
  return { id: session.user.id, email, token: session.access_token }
}

async function subscriberClient(who: Account): Promise<ReturnType<typeof createClient>> {
  const client = createClient({ url: stack().baseUrl, anonKey: stack().anonKey })
  const { error } = await client.auth.signInWithPassword({ email: who.email, password: PASSWORD })
  if (error) throw new Error(error.message)
  return client
}

async function setSalary(id: string, salary: number): Promise<void> {
  const res = await api("PATCH", `/rest/v1/employee?id=eq.${id}`, stack().serviceKey, { salary })
  expect(res.status).toBeLessThan(300)
}

/** Read an open SSE response for up to `ms`, returning everything it sent. */
async function readFor(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))])
    if (chunk === null || chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return text
}

function changeEvents(text: string): Array<{ deliveries: Array<{ connectionId: string; payload?: { new: Record<string, unknown> }; redacted?: { new: string[] } }>; viewer?: { visible: boolean; payload?: { new: Record<string, unknown> }; redacted?: { new: string[] } } }> {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: change\n"))
    .map((block) => JSON.parse(block.split("\ndata: ")[1]!))
}

test.beforeAll(async () => {
  const [owner, developer, editor, admin] = [await account("owner"), await account("dev"), await account("editor"), await account("admin")]
  sql(`INSERT INTO _supatype.studio_members (user_id, role) VALUES
    ('${developer.id}', 'developer'), ('${editor.id}', 'editor'), ('${admin.id}', 'admin')`)
  for (const [who, salary] of [[owner, 120000], [developer, 95000]] as const) {
    const res = await api("POST", "/rest/v1/employee", stack().serviceKey, { id: who.id, name: `name-${who.email}`, grade: 10, salary, ssn: `SSN-${who.id.slice(0, 4)}` })
    expect(res.status, await res.text()).toBeLessThan(300)
  }
  const project = await api("GET", "/studio/proxy/platform/v1/project", developer.token)
  expect(project.status).toBe(200)
  const ref = ((await project.json()) as { data: { ref: string } }).data.ref
  world = { owner, developer, editor, admin, ref }
})

async function studioAs(page: Page, who: Account, path: string): Promise<void> {
  await signInToStudio(page, { email: who.email, password: PASSWORD })
  await page.goto(`/studio${path}`)
}

test("a masked column shows as redacted to a developer, and its value never reaches the browser", async ({ page }) => {
  const seen: string[] = []
  page.on("response", (res) => {
    if (!res.url().includes("/realtime/stream")) void res.text().then((t) => seen.push(t)).catch(() => {})
  })
  const owner = await subscriberClient(world.owner)
  const sub = owner.from("employee").subscribe(() => {}, { event: "*" })
  await new Promise<void>((resolve) => sub.channel.subscribe((s) => { if (s === "SUBSCRIBED") resolve() }))

  await studioAs(page, world.developer, "/realtime/stream")
  await expect(page.getByText("As you would receive it")).toBeVisible()
  await setSalary(world.owner.id, 777001)

  const row = page.getByRole("button", { name: /UPDATE\s*public\.employee/ })
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.locator("main")).toContainText('"salary": redacted')
  expect(await page.content()).not.toContain("777001")
  expect(seen.join("\n")).not.toContain("777001")
  sub.unsubscribe()
})

test("a test broadcast from Studio reaches a subscriber and is audited without its payload", async ({ page }) => {
  const owner = await subscriberClient(world.owner)
  const received: Array<Record<string, unknown>> = []
  const channel = owner.realtime.channel("room:1").onBroadcast("hello", (payload) => received.push(payload))
  await new Promise<void>((resolve) => channel.subscribe((s) => { if (s === "SUBSCRIBED") resolve() }))

  await studioAs(page, world.developer, "/realtime/broadcast")
  await page.getByLabel("Channel").fill("room:1")
  await page.getByLabel("Event").fill("hello")
  await page.getByLabel("Payload").fill('{ "hello": "world" }')
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Sent to 1 subscriber.")).toBeVisible()
  await expect.poll(() => received).toEqual([{ hello: "world" }])

  const audit = sql(`SELECT detail::text FROM _supatype.studio_audit WHERE action = 'realtime_broadcast' AND actor_id = '${world.developer.id}'`)
  expect(audit).toContain('"payloadBytes": 17')
  expect(audit).not.toContain("world")
  channel.unsubscribe()
})

test("the Inspector shows the channels a subscriber holds, live", async ({ page }) => {
  const owner = await subscriberClient(world.owner)
  const channel = owner.realtime.channel("room:live").onBroadcast("x", () => {})
  await new Promise<void>((resolve) => channel.subscribe((s) => { if (s === "SUBSCRIBED") resolve() }))
  await studioAs(page, world.developer, "/realtime/channels")
  await expect(page.locator("main")).toContainText("room:live")
  channel.unsubscribe()
})

test("an editor has no Realtime nav item and is refused", async ({ page }) => {
  const base = `/studio/proxy/platform/v1/projects/${world.ref}/realtime`
  expect((await api("GET", `${base}/channels`, world.editor.token)).status).toBe(403)
  expect((await api("GET", "/studio/proxy/platform/v1/project", world.editor.token)).status).toBe(403)
  await studioAs(page, world.editor, "/realtime")
  await expect(page.getByText("not available to your role")).toBeVisible()
  await expect(page.locator('[aria-label="Studio navigation"] [title="Realtime"]')).toHaveCount(0)
})

test("a developer reaches the Inspector and nothing else on the control plane", async () => {
  const base = `/studio/proxy/platform/v1/projects/${world.ref}`
  expect((await api("GET", `${base}/realtime/channels`, world.developer.token)).status).toBe(200)
  expect((await api("PATCH", `${base}/realtime/settings`, world.developer.token, {})).status).toBe(403)
  expect((await api("POST", `${base}/schema/push`, world.developer.token, {})).status).toBe(403)
  expect((await api("GET", `${base}/status`, world.developer.token)).status).toBe(403)
})

test("the admin API is not reachable from outside", async () => {
  const realtime = stack().realtimeContainer
  const project = realtime.replace(/-realtime-1$/, "")
  expect((await api("GET", "/realtime/v1/admin/v1/channels", stack().serviceKey)).status).toBe(404)
  const probe = (container: string, url: string, token: string): string =>
    execFileSync("docker", ["exec", container, "node", "-e",
      `fetch(${JSON.stringify(url)},{headers:{Authorization:${JSON.stringify(`Bearer ${token}`)}}}).then(r=>console.log(r.status)).catch(e=>console.log("error "+e.message))`],
    { encoding: "utf8" }).trim()
  expect(probe(`${project}-control-plane-1`, "http://realtime:4001/admin/v1/channels", world.owner.token)).toBe("403")
  expect(probe(`${project}-control-plane-1`, "http://realtime:4001/admin/v1/channels", stack().serviceKey)).toBe("200")
  expect(probe(realtime, "http://control-plane:8080/project", stack().serviceKey)).toBe("401")
})

test("an admin sees each delivery as received; a developer's stream never carries the value", async () => {
  const owner = await subscriberClient(world.owner)
  const sub = owner.from("employee").subscribe(() => {}, { event: "*" })
  await new Promise<void>((resolve) => sub.channel.subscribe((s) => { if (s === "SUBSCRIBED") resolve() }))
  const open = (who: Account): Promise<Response> =>
    fetch(`${stack().baseUrl}/studio/proxy/platform/v1/projects/${world.ref}/realtime/stream?table=employee`, {
      headers: { apikey: stack().anonKey, Authorization: `Bearer ${who.token}` },
    })
  const [asAdmin, asDeveloper] = [await open(world.admin), await open(world.developer)]
  expect([asAdmin.status, asDeveloper.status]).toEqual([200, 200])
  const reads = [readFor(asAdmin, 4000), readFor(asDeveloper, 4000)]
  await new Promise((r) => setTimeout(r, 500))
  await setSalary(world.owner.id, 888002)
  const [adminText, developerText] = await Promise.all(reads)

  const delivery = changeEvents(adminText)[0]!.deliveries[0]!
  expect(delivery.payload!.new["salary"]).toBeNull()
  expect(delivery.redacted!.new).toContain("salary")
  expect(delivery.payload!.new["ssn"]).toBe(`SSN-${world.owner.id.slice(0, 4)}`)
  expect(developerText).toContain('"view":"viewer"')
  expect(developerText).not.toContain("888002")
  expect(adminText).not.toContain("888002")
  expect(sql(`SELECT count(*) FROM _supatype.studio_audit WHERE action = 'realtime_inspect' AND actor_id = '${world.admin.id}'`)).toBe("1")
  sub.unsubscribe()
})

test("the eleventh test broadcast in a minute is refused with the time to wait", async () => {
  const path = `/studio/proxy/platform/v1/projects/${world.ref}/realtime/broadcast`
  const statuses: number[] = []
  let retryAfter: string | null = null
  for (let i = 0; i < 11; i++) {
    const res = await api("POST", path, world.admin.token, { channel: "room:rate", event: "n", payload: { i } })
    statuses.push(res.status)
    if (res.status === 429) {
      retryAfter = res.headers.get("retry-after")
      break
    }
  }
  expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
  expect(statuses[10]).toBe(429)
  expect(Number(retryAfter)).toBeGreaterThan(0)
})
