import { useCallback, useMemo, useState } from "react"
import { anonKeyValue, client, gatewayUrl } from "./client"

type InvokeResult = {
  id: string
  at: string
  title: string
  ok: boolean
  ms: number
  body: unknown
}

const WEBHOOK_SECRET = "edge-kit-dev-webhook-secret"

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

type Scenario = {
  id: string
  name: string
  blurb: string
  expect: string
  run: (ctx: {
    echoBody: string
    noteText: string
    webhookBody: string
    setSessionEmail: (email: string | null) => void
  }) => Promise<unknown>
}

const scenarios: Scenario[] = [
  {
    id: "ping",
    name: "ping",
    blurb: "Health check via client.functions.invoke",
    expect: "200 · { ok: true }",
    run: async () => {
      const { data, error } = await client.functions.invoke("ping", { method: "GET" })
      if (error) throw new Error(error.message)
      return data
    },
  },
  {
    id: "env-check",
    name: "env-check",
    blurb: "Confirms Deno.env has Supatype keys (+ WEBHOOK_SECRET)",
    expect: "hasSupatypeUrl / hasAnonKey / hasServiceRoleKey true",
    run: async () => {
      const { data, error } = await client.functions.invoke("env-check", { method: "GET" })
      if (error) throw new Error(error.message)
      return data
    },
  },
  {
    id: "echo",
    name: "echo",
    blurb: "Round-trip the JSON payload below",
    expect: "body echoed under .body",
    run: async ({ echoBody }) => {
      let parsed: unknown = echoBody
      try {
        parsed = JSON.parse(echoBody)
      } catch {
        // send as string field
        parsed = { raw: echoBody }
      }
      const { data, error } = await client.functions.invoke("echo", { body: parsed })
      if (error) throw new Error(error.message)
      return data
    },
  },
  {
    id: "auth-raw",
    name: "auth-required · no Bearer",
    blurb: "Raw fetch with only apikey — should fail",
    expect: "401 unauthorized",
    run: async () => {
      const res = await fetch(`${gatewayUrl}/functions/v1/auth-required`, {
        method: "POST",
        headers: { apikey: anonKeyValue, "Content-Type": "application/json" },
        body: "{}",
      })
      const body = await res.json().catch(() => ({}))
      return { status: res.status, body }
    },
  },
  {
    id: "auth-anon",
    name: "auth-required · anon JWT",
    blurb: "Client invoke with default anon Bearer — should fail",
    expect: "401 · anon key not enough",
    run: async () => {
      const { data, error } = await client.functions.invoke("auth-required", { body: {} })
      return { data, error }
    },
  },
  {
    id: "auth-user",
    name: "auth-required · user session",
    blurb: "Sign up ephemeral user, then invoke with user JWT",
    expect: "200 · Bearer accepted",
    run: async ({ setSessionEmail }) => {
      const email = `edge-kit-${Date.now()}@example.com`
      const password = "edge-kit-test-password-1"
      const { data: signData, error: signErr } = await client.auth.signUp({ email, password })
      if (signErr) throw new Error(signErr.message)
      if (!signData.session) {
        throw new Error("signUp returned no session — is GOTRUE_MAILER_AUTOCONFIRM=true?")
      }
      setSessionEmail(email)
      const { data, error } = await client.functions.invoke("auth-required", { body: {} })
      if (error) throw new Error(error.message)
      return { email, data }
    },
  },
  {
    id: "write-note",
    name: "write-note",
    blurb: "Deno function inserts a Note with the service role",
    expect: "200 · note row in response",
    run: async ({ noteText }) => {
      const { data, error } = await client.functions.invoke("write-note", {
        body: { text: noteText },
      })
      if (error) throw new Error(error.message)
      return data
    },
  },
  {
    id: "webhook",
    name: "webhook",
    blurb: "HMAC-SHA256 of the payload (x-webhook-signature)",
    expect: "200 · ok when signature matches WEBHOOK_SECRET",
    run: async ({ webhookBody }) => {
      const signature = await hmacSha256Hex(WEBHOOK_SECRET, webhookBody)
      const res = await fetch(`${gatewayUrl}/functions/v1/webhook`, {
        method: "POST",
        headers: {
          apikey: anonKeyValue,
          Authorization: `Bearer ${anonKeyValue}`,
          "Content-Type": "application/json",
          "x-webhook-signature": signature,
        },
        body: webhookBody,
      })
      const body = await res.json().catch(() => ({}))
      return { status: res.status, signature, body }
    },
  },
]

export function App() {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [history, setHistory] = useState<InvokeResult[]>([])
  const [echoBody, setEchoBody] = useState('{\n  "hello": "edge-kit"\n}')
  const [noteText, setNoteText] = useState("hello from the edge kit UI")
  const [webhookBody, setWebhookBody] = useState('{\n  "event": "test",\n  "n": 1\n}')

  const latest = history[0] ?? null

  const ctx = useMemo(
    () => ({ echoBody, noteText, webhookBody, setSessionEmail }),
    [echoBody, noteText, webhookBody],
  )

  const runScenario = useCallback(
    async (scenario: Scenario) => {
      setBusyId(scenario.id)
      const started = performance.now()
      try {
        const body = await scenario.run(ctx)
        setHistory((prev) => [
          {
            id: `${scenario.id}-${Date.now()}`,
            at: new Date().toISOString(),
            title: scenario.name,
            ok: true,
            ms: Math.round(performance.now() - started),
            body,
          },
          ...prev,
        ].slice(0, 12))
      } catch (err) {
        setHistory((prev) => [
          {
            id: `${scenario.id}-${Date.now()}`,
            at: new Date().toISOString(),
            title: scenario.name,
            ok: false,
            ms: Math.round(performance.now() - started),
            body: err instanceof Error ? { message: err.message } : err,
          },
          ...prev,
        ].slice(0, 12))
      } finally {
        setBusyId(null)
      }
    },
    [ctx],
  )

  const runAll = useCallback(async () => {
    for (const scenario of scenarios) {
      await runScenario(scenario)
    }
  }, [runScenario])

  const signOut = useCallback(async () => {
    await client.auth.signOut()
    setSessionEmail(null)
  }, [])

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="brand">Supatype</p>
          <h1>Edge Kit</h1>
          <p className="lede">
            Trigger every sample function from the browser. Use this to verify Deno IDE types,
            env injection, auth gates, service-role writes, and webhook HMAC.
          </p>
          <div className="meta">
            <span>
              Gateway <code>{gatewayUrl}</code>
            </span>
            <span>
              Session{" "}
              <code>{sessionEmail ?? "anon"}</code>
              {sessionEmail ? (
                <button type="button" className="linkish" onClick={() => void signOut()}>
                  sign out
                </button>
              ) : null}
            </span>
          </div>
        </div>
        <div className="hero-actions">
          <button type="button" className="primary" disabled={busyId !== null} onClick={() => void runAll()}>
            Run all scenarios
          </button>
          <button
            type="button"
            disabled={history.length === 0}
            onClick={() => setHistory([])}
          >
            Clear history
          </button>
        </div>
      </header>

      <div className="columns">
        <div className="col col-controls">
          <section className="inputs" aria-label="Request payloads">
            <label>
              <span>echo body (JSON)</span>
              <textarea
                value={echoBody}
                onChange={(e) => setEchoBody(e.target.value)}
                rows={4}
                spellCheck={false}
              />
            </label>
            <label>
              <span>write-note text</span>
              <input value={noteText} onChange={(e) => setNoteText(e.target.value)} />
            </label>
            <label>
              <span>webhook body (signed with {WEBHOOK_SECRET})</span>
              <textarea
                value={webhookBody}
                onChange={(e) => setWebhookBody(e.target.value)}
                rows={4}
                spellCheck={false}
              />
            </label>
          </section>

          <section className="scenarios" aria-label="Functions">
            {scenarios.map((scenario) => (
              <article key={scenario.id} className="scenario">
                <div>
                  <h2>{scenario.name}</h2>
                  <p>{scenario.blurb}</p>
                  <p className="expect">Expect: {scenario.expect}</p>
                </div>
                <button
                  type="button"
                  className="primary"
                  disabled={busyId !== null}
                  onClick={() => void runScenario(scenario)}
                >
                  {busyId === scenario.id ? "Running…" : "Invoke"}
                </button>
              </article>
            ))}
          </section>
        </div>

        <aside className="col col-results" aria-label="Results">
          <section className="results">
            <h2>Latest result</h2>
            {latest ? (
              <div className={`panel${latest.ok ? "" : " err"}`}>
                <div className="panel-head">
                  <strong>{latest.ok ? "OK" : "Error"}</strong>
                  <span>{latest.title}</span>
                  <span className="muted">{latest.ms}ms</span>
                  <span className="muted">{latest.at}</span>
                </div>
                <pre>{JSON.stringify(latest.body, null, 2)}</pre>
              </div>
            ) : (
              <p className="muted">Invoke a function to see the response here.</p>
            )}

            {history.length > 1 ? (
              <>
                <h2>History</h2>
                <ul className="history">
                  {history.slice(1).map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="history-item"
                        onClick={() =>
                          setHistory((prev) => [item, ...prev.filter((x) => x.id !== item.id)])
                        }
                      >
                        <span className={item.ok ? "ok" : "bad"}>{item.ok ? "OK" : "ERR"}</span>
                        <span>{item.title}</span>
                        <span className="muted">{item.ms}ms</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  )
}
