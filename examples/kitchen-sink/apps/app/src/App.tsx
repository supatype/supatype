import React, { useState } from "react"
import { useAuth } from "@supatype/react"
import { AuthScreen } from "./AuthScreen.js"
import { ScheduleScreen } from "./ScheduleScreen.js"
import { LobbyScreen } from "./LobbyScreen.js"
import { TicketScreen } from "./TicketScreen.js"

/**
 * The attendee app: the session-shaped half of the kitchen sink.
 *
 * Every screen here needs a signed-in caller to be interesting, which is the line this half of the
 * example is drawn along. What an editor publishes lives in `apps/marketing`, rendered on the
 * server, and shares nothing with this but the schema.
 *
 * One screen per surface, each saying what it proves. A screen that cannot say so does not belong.
 */
const SCREENS = [
  { id: "schedule", label: "Schedule", proves: "useQuery, relations, ordering" },
  { id: "lobby", label: "Lobby", proves: "realtime: subscribe, then write" },
  { id: "ticket", label: "My ticket", proves: "per-row access: OwnerFrom" },
] as const

type ScreenId = (typeof SCREENS)[number]["id"]

export function App(): React.ReactElement {
  const { user, loading, signOut } = useAuth()
  const [screen, setScreen] = useState<ScreenId>("schedule")

  if (loading) return <main className="ks-shell"><p className="ks-muted">Loading session…</p></main>

  // Not a route guard bolted on: every model below is unreadable to `anon` by its own access rule,
  // so signing out empties these screens whatever the UI does.
  if (!user) return <AuthScreen />

  const active = SCREENS.find((s) => s.id === screen)!

  return (
    <main className="ks-shell">
      <header className="ks-header">
        <div>
          <h1>Kitchen Sink</h1>
          <p className="ks-muted">{user.email}</p>
        </div>
        <button className="ks-ghost" onClick={() => void signOut()}>Sign out</button>
      </header>

      <nav className="ks-tabs">
        {SCREENS.map((s) => (
          <button
            key={s.id}
            className={s.id === screen ? "ks-tab ks-tab--active" : "ks-tab"}
            onClick={() => setScreen(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <p className="ks-proves">Proves: {active.proves}</p>

      {screen === "schedule" && <ScheduleScreen />}
      {screen === "lobby" && <LobbyScreen />}
      {screen === "ticket" && <TicketScreen userId={user.id} />}
    </main>
  )
}
