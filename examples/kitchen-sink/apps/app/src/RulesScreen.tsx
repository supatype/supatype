import React, { useState } from "react"
import { supatype } from "./client.js"

type Attempt = { label: string; explains: string; body: string }

/**
 * Three ways to refuse a value, and the point is that they are different.
 *
 * Each button sends a lobby message that breaks one rule. All three come back as an error, so the
 * interesting part is not *that* they fail — it is where the rule lives and what it can say:
 *
 *   - the **bound** (`MaxLength<string, 500>`) and the **constraint** (`Length(body) >= 2`) are
 *     `CHECK`s, so they hold for `psql`, seeds and migrations too. Postgres refuses them, and the
 *     message names a constraint rather than a field.
 *   - the **validator** runs on the API write path only, which is its weakness and its whole
 *     point: it is the one that can name the field, which is what lets Studio put the message on
 *     the input instead of in a banner.
 *
 * Anything a bound could say should be a bound. A validator is for what a `CHECK` cannot express.
 */
const ATTEMPTS: Attempt[] = [
  {
    label: "Too long (bound)",
    explains: "MaxLength<string, 500> — a CHECK, so psql refuses it too",
    body: "x".repeat(600),
  },
  {
    label: "Too short (constraint)",
    explains: "Gte<Length<\"body\">, Literal<2>> — also a CHECK, but reads the column",
    body: "x",
  },
  {
    label: "Shouting (validator)",
    explains: "an edge function on the write path — the only one that names the field",
    body: "HELLO EVERYONE",
  },
]

export function RulesScreen(): React.ReactElement {
  const [results, setResults] = useState<Record<string, string>>({})

  async function attempt(a: Attempt): Promise<void> {
    const { error } = await supatype.from("chat_message").insert({ room: "lobby", body: a.body })
    setResults((current) => ({
      ...current,
      // A write that succeeds here is the interesting failure: it means the rule is not being
      // enforced, which is invisible in an app that only ever sends valid values.
      [a.label]: error === null ? "ACCEPTED — the rule is not being enforced" : error.message,
    }))
  }

  return (
    <section>
      <p className="ks-muted">
        Each of these breaks one rule. They all fail — what differs is where the rule lives and how
        much the refusal can tell you.
      </p>

      {ATTEMPTS.map((a) => (
        <div key={a.label} className="ks-card">
          <h3>{a.label}</h3>
          <p className="ks-muted"><code>{a.explains}</code></p>
          <button className="ks-ghost" onClick={() => void attempt(a)}>Try it</button>
          {results[a.label] !== undefined && (
            <p className={results[a.label]!.startsWith("ACCEPTED") ? "ks-error" : "ks-muted"}>
              {results[a.label]}
            </p>
          )}
        </div>
      ))}
    </section>
  )
}
