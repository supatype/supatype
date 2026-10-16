/**
 * A stand-in OAuth provider for the expo-auth and kitchen-sink suites, shaped like GitHub
 * Enterprise. The suites start it through tests/integration/scripts/lib/oauth-stub.sh.
 *
 * The auth server's GitHub provider takes a base URL (SUPATYPE_EXTERNAL_GITHUB_URL) and calls
 * `<url>/login/oauth/authorize`, `<url>/login/oauth/access_token`, `<url>/api/v3/user` and
 * `<url>/api/v3/user/emails`. This answers those four, so the whole sign-in runs against a real
 * auth server without a real GitHub: the browser is sent here and straight back with a code, the
 * server exchanges the code and reads the user, and the app finishes the PKCE exchange.
 *
 * It checks what a provider checks (the client id on authorize, the client secret and a code it
 * issued on exchange, the token on the user calls) so a server that skipped a step fails here
 * instead of passing against a stub that accepted anything.
 *
 *   node oauth-stub.mjs   (env: OAUTH_STUB_PORT, OAUTH_STUB_CLIENT_ID, OAUTH_STUB_SECRET, OAUTH_STUB_EMAIL)
 *
 * GET /calls lists what was asked of it, for the suite to assert on.
 */
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"

const PORT = Number(process.env.OAUTH_STUB_PORT ?? "18999")
const CLIENT_ID = process.env.OAUTH_STUB_CLIENT_ID ?? "expo-e2e-client"
const SECRET = process.env.OAUTH_STUB_SECRET ?? "expo-e2e-secret"
const EMAIL = process.env.OAUTH_STUB_EMAIL ?? "octo@example.com"

const codes = new Set()
const tokens = new Set()
const calls = []

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers })
  res.end(body === undefined ? "" : JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ""
    req.on("data", (chunk) => (text += chunk))
    req.on("end", () => resolve(text))
    req.on("error", reject)
  })
}

/** The client credentials, from Basic auth or the form, whichever the caller used. */
function clientCredentials(req, form) {
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "")
  if (basic !== null) {
    const [id, secret] = Buffer.from(basic[1], "base64").toString("utf8").split(":").map(decodeURIComponent)
    return { id, secret }
  }
  return { id: form.get("client_id"), secret: form.get("client_secret") }
}

function authorize(url, res) {
  const redirect = url.searchParams.get("redirect_uri")
  if (url.searchParams.get("client_id") !== CLIENT_ID || redirect === null) {
    return send(res, 400, { error: "invalid_client" })
  }
  const code = randomUUID()
  codes.add(code)
  const back = new URL(redirect)
  back.searchParams.set("code", code)
  back.searchParams.set("state", url.searchParams.get("state") ?? "")
  send(res, 302, undefined, { Location: back.toString() })
}

async function exchange(req, res) {
  const form = new URLSearchParams(await readBody(req))
  const client = clientCredentials(req, form)
  if (client.id !== CLIENT_ID || client.secret !== SECRET) return send(res, 401, { error: "invalid_client" })
  const code = form.get("code")
  if (code === null || !codes.delete(code)) return send(res, 400, { error: "bad_verification_code" })
  const token = randomUUID()
  tokens.add(token)
  send(res, 200, { access_token: token, token_type: "bearer", scope: "user:email" })
}

function user(req, res, path) {
  const bearer = /^(?:Bearer|token)\s+(.+)$/i.exec(req.headers.authorization ?? "")
  if (bearer === null || !tokens.has(bearer[1])) return send(res, 401, { message: "Bad credentials" })
  if (path.endsWith("/emails")) return send(res, 200, [{ email: EMAIL, primary: true, verified: true }])
  send(res, 200, { id: 4242, login: "octo-e2e", name: "Octo E2E", email: EMAIL, avatar_url: "" })
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
  calls.push(`${req.method} ${url.pathname}`)
  const route = `${req.method} ${url.pathname}`
  if (route === "GET /login/oauth/authorize") return authorize(url, res)
  if (route === "POST /login/oauth/access_token") return void exchange(req, res).catch(() => send(res, 500, {}))
  if (route === "GET /api/v3/user" || route === "GET /api/v3/user/emails") return user(req, res, url.pathname)
  if (route === "GET /calls") return send(res, 200, calls.slice(0, -1))
  send(res, 404, { error: "not_found" })
})

// Every interface: the auth server reaches this from a container, through host.docker.internal.
server.listen(PORT, "0.0.0.0", () => console.log(`oauth stub on :${PORT}`))
