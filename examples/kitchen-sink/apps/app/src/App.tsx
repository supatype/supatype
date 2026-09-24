import React, { useState } from "react"
import { useAuth, useQuery } from "@supatype/react"
import type { Database } from "../../../supatype/generated/database"
import { AuthScreen } from "./AuthScreen.js"
import { ProgrammeScreen } from "./ProgrammeScreen.js"
import { SpeakersScreen } from "./SpeakersScreen.js"
import { LobbyScreen } from "./LobbyScreen.js"
import { TicketScreen } from "./TicketScreen.js"
import { SponsorsScreen } from "./SponsorsScreen.js"
import { AccountScreen } from "./AccountScreen.js"
import { Button } from "./components/ui.js"
import { localizedOr } from "./lib/localized.js"

type SiteSettings = Database["public"]["Tables"]["_global_site_settings"]["Row"]

/**
 * The attendee app: the session-shaped half of the kitchen sink.
 *
 * Organised by what an attendee does, not by which API each screen exercises. The previous version
 * had tabs called "Media" and "Rules" with a `Proves: useQuery, relations, ordering` caption under
 * the navigation — which covered the same surfaces while reading as a test fixture rather than a
 * conference. Uploading is now part of an account, and the three refusals happen where an attendee
 * would actually meet them: on the chat composer, when a message is rejected.
 *
 * What an editor publishes lives in `apps/marketing`, rendered on the server, and shares nothing
 * with this but the schema.
 */
const SCREENS = [
  { id: "programme", label: "Programme", glyph: "◷" },
  { id: "speakers", label: "Speakers", glyph: "◎" },
  { id: "lobby", label: "Lobby", glyph: "◇" },
  { id: "ticket", label: "My ticket", glyph: "▤" },
  { id: "sponsors", label: "Sponsors", glyph: "◈" },
  { id: "account", label: "Account", glyph: "☺" },
] as const

type ScreenId = (typeof SCREENS)[number]["id"]

export function App(): React.ReactElement {
  const { user, loading, signOut } = useAuth()
  const [screen, setScreen] = useState<ScreenId>("programme")

  if (loading) {
    return (
      <div className="ks-auth">
        <p className="ks-muted">Loading session…</p>
      </div>
    )
  }

  // Not a route guard bolted on: every model below is unreadable to `anon` by its own access rule,
  // so signing out empties these screens whatever the UI does.
  if (!user) return <AuthScreen />

  return (
    <div className="ks-app">
      <ConferenceBar email={user.email ?? ""} onSignOut={() => void signOut()} />

      <nav className="ks-navstrip" aria-label="Sections">
        <NavItems screen={screen} onPick={setScreen} />
      </nav>

      <div className="ks-body">
        <nav className="ks-nav" aria-label="Sections">
          <NavItems screen={screen} onPick={setScreen} />
        </nav>

        <main className="ks-main">
          <div className="ks-main__inner">
            {screen === "programme" && <ProgrammeScreen />}
            {screen === "speakers" && <SpeakersScreen />}
            {screen === "lobby" && <LobbyScreen userId={user.id} email={user.email ?? ""} />}
            {screen === "ticket" && <TicketScreen userId={user.id} />}
            {screen === "sponsors" && <SponsorsScreen />}
            {screen === "account" && <AccountScreen email={user.email ?? ""} />}
          </div>
        </main>
      </div>
    </div>
  )
}

function NavItems({
  screen,
  onPick,
}: {
  screen: ScreenId
  onPick: (id: ScreenId) => void
}): React.ReactElement {
  return (
    <>
      {SCREENS.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-current={s.id === screen ? "page" : undefined}
          className={s.id === screen ? "ks-nav__item ks-nav__item--active" : "ks-nav__item"}
          onClick={() => onPick(s.id)}
        >
          <span className="ks-nav__glyph" aria-hidden="true">{s.glyph}</span>
          {s.label}
        </button>
      ))}
    </>
  )
}

/**
 * The conference's own name, from the database rather than a constant.
 *
 * `SiteSettings` is a singleton an editor owns in Studio, and until now nothing in this half of the
 * example read it — the app announced itself as "Kitchen Sink", which is the name of the sample
 * rather than the name of the event it is pretending to run.
 */
function ConferenceBar({
  email,
  onSignOut,
}: {
  email: string
  onSignOut: () => void
}): React.ReactElement {
  const { data } = useQuery<Database, "_global_site_settings", SiteSettings>(
    "_global_site_settings",
    { limit: 1 },
  )
  const settings = data?.[0]

  return (
    <header className="ks-topbar">
      <div className="ks-topbar__brand">
        <span className="ks-topbar__name">{settings?.conferenceName ?? "Conference"}</span>
        <span className="ks-topbar__tagline">
          {localizedOr(settings?.tagline, "en", "Two days of people explaining their schemas")}
        </span>
      </div>
      <span className="ks-topbar__spacer" />
      <span className="ks-topbar__who ks-truncate">{email}</span>
      <Button variant="ghost" size="sm" onClick={onSignOut}>
        Sign out
      </Button>
    </header>
  )
}
