import { useState } from "react"
import { RichTextEditor } from "@supatype/ui"
import { useAuth } from "./useAuth"
import { earnStars, redeemReward, updateProfile, type RichTextDoc } from "./api"
import { MENU, REWARDS, tierFor, nextReward, GOLD_THRESHOLD, type MenuItem, type Reward } from "./catalog"

type View = "home" | "rewards" | "profile"

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`

/** True if a Lexical doc has any text content (so we don't render an empty bio block). */
function richTextHasContent(doc: RichTextDoc | null): boolean {
  if (!doc) return false
  const root = (doc as unknown as { root?: { children?: unknown[] } }).root
  return JSON.stringify(root?.children ?? []).includes('"text":"')
}

/** Stable fingerprint of a doc — used as a remount key so the read-only editor
 *  reloads when the bio changes (it otherwise only reads `value` once on mount). */
function docRevision(doc: RichTextDoc | null): string {
  const s = JSON.stringify(doc ?? null)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// ─── App shell ────────────────────────────────────────────────────────────────

export default function App() {
  const { ready, user } = useAuth()
  const [view, setView] = useState<View>("home")
  const [flash, setFlash] = useState<string | null>(null)

  const showFlash = (msg: string) => {
    setFlash(msg)
    window.clearTimeout((showFlash as unknown as { t?: number }).t)
    ;(showFlash as unknown as { t?: number }).t = window.setTimeout(() => setFlash(null), 3200)
  }

  if (!ready) {
    return (
      <div className="splash">
        <img src="/logo.svg" alt="" className="splash-logo" />
      </div>
    )
  }

  const requiresAuth = view === "rewards" || view === "profile"

  return (
    <div className="app">
      <Nav view={view} setView={setView} />
      {flash && <div className="flash">{flash}</div>}
      <main className="main">
        {view === "home" && <Home setView={setView} onFlash={showFlash} />}
        {requiresAuth && !user && <AuthScreen intent={view} />}
        {view === "rewards" && user && <Rewards onFlash={showFlash} />}
        {view === "profile" && user && <Profile />}
      </main>
      <footer className="footer">
        <span>Supabucks is a demo built on Supatype — one TypeScript schema, full backend.</span>
      </footer>
    </div>
  )
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function Nav({ view, setView }: { view: View; setView: (v: View) => void }) {
  const { user, customer, signOut } = useAuth()
  return (
    <header className="nav">
      <button className="brand" onClick={() => setView("home")}>
        <img src="/logo.svg" alt="" />
        <span>Supabucks</span>
      </button>
      <nav className="nav-links">
        <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}>Home</button>
        <button className={view === "rewards" ? "active" : ""} onClick={() => setView("rewards")}>Rewards</button>
        <button className={view === "profile" ? "active" : ""} onClick={() => setView("profile")}>Profile</button>
      </nav>
      <div className="nav-right">
        {user && customer && (
          <button className="stars-chip" onClick={() => setView("profile")}>
            <span className="star">★</span> {customer.stars}
          </button>
        )}
        {user ? (
          <button className="btn btn-ghost" onClick={() => void signOut()}>Sign out</button>
        ) : (
          <button className="btn btn-primary" onClick={() => setView("profile")}>Join / Sign in</button>
        )}
      </div>
    </header>
  )
}

// ─── Home ─────────────────────────────────────────────────────────────────────

function Home({ setView, onFlash }: { setView: (v: View) => void; onFlash: (m: string) => void }) {
  const { user, customer } = useAuth()
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <p className="hero-kicker">Supabucks Rewards</p>
          <h1>Earn stars with every sip.</h1>
          <p className="hero-sub">
            Collect stars on everything you order and redeem them for free drinks and treats.
            It pays to be a regular.
          </p>
          {!user && (
            <button className="btn btn-primary btn-lg" onClick={() => setView("profile")}>
              Join Supabucks — it's free
            </button>
          )}
        </div>
        <div className="hero-art" aria-hidden>☕</div>
      </section>

      {user && customer && <LoyaltyCard />}

      <section className="section">
        <h2 className="section-title">{user ? "Order & earn" : "How it works"}</h2>
        {!user && (
          <div className="steps">
            <div className="step"><span className="step-emoji">🟢</span><h3>Join free</h3><p>Create an account in seconds.</p></div>
            <div className="step"><span className="step-emoji">★</span><h3>Earn stars</h3><p>Collect stars on every order.</p></div>
            <div className="step"><span className="step-emoji">🎁</span><h3>Get rewards</h3><p>Redeem stars for free drinks.</p></div>
          </div>
        )}
        {user && customer && <EarnGrid onFlash={onFlash} />}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Popular rewards</h2>
          {user && <button className="link" onClick={() => setView("rewards")}>See all →</button>}
        </div>
        <div className="reward-grid">
          {REWARDS.slice(0, 3).map((r) => (
            <RewardCard key={r.id} reward={r} compact />
          ))}
        </div>
      </section>
    </>
  )
}

// ─── Loyalty card ───────────────────────────────────────────────────────────--

function LoyaltyCard() {
  const { customer, user } = useAuth()
  if (!customer) return null
  const tier = tierFor(customer.lifetimeStars)
  const next = nextReward(customer.stars)
  const goal = next?.cost ?? customer.stars
  const pct = Math.min(100, goal === 0 ? 100 : Math.round((customer.stars / goal) * 100))
  return (
    <section className="loyalty">
      <div className={`loyalty-card tier-${tier}`}>
        <div className="loyalty-top">
          <div>
            <p className="loyalty-name">{customer.name}</p>
            <p className="loyalty-email">{user?.email}</p>
          </div>
          <span className={`tier-badge tier-${tier}`}>{tier === "gold" ? "★ Gold" : "Green"}</span>
        </div>
        {richTextHasContent(customer.bio) && (
          <div className="loyalty-bio">
            <RichTextEditor
              value={customer.bio}
              onChange={() => {}}
              editable={false}
              documentKey={`bio-view-${customer.id}-${docRevision(customer.bio)}`}
            />
          </div>
        )}
        <div className="loyalty-balance">
          <span className="loyalty-stars">{customer.stars}</span>
          <span className="loyalty-stars-label">stars available</span>
        </div>
        <div className="loyalty-progress">
          <div className="loyalty-bar"><div className="loyalty-fill" style={{ width: `${pct}%` }} /></div>
          <p className="loyalty-hint">
            {next
              ? `${next.cost - customer.stars} more stars for a ${next.name} ${next.emoji}`
              : "You can redeem any reward in the catalogue ✨"}
          </p>
        </div>
        {tier === "green" && (
          <p className="loyalty-tier-hint">
            {GOLD_THRESHOLD - customer.lifetimeStars > 0
              ? `${GOLD_THRESHOLD - customer.lifetimeStars} lifetime stars to reach Gold`
              : "Gold unlocked"}
          </p>
        )}
      </div>
    </section>
  )
}

// ─── Earn grid (simulated ordering) ─────────────────────────────────────────--

function EarnGrid({ onFlash }: { onFlash: (m: string) => void }) {
  const { customer, setCustomer, refreshActivity } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)
  if (!customer) return null

  const buy = async (item: MenuItem) => {
    setBusy(item.label)
    try {
      const updated = await earnStars(customer, item)
      setCustomer(updated)
      await refreshActivity()
      onFlash(`+${item.stars}★ for your ${item.label}`)
    } catch (e) {
      onFlash((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="menu-grid">
      {MENU.map((item) => (
        <div className="menu-card" key={item.label}>
          <div className="menu-emoji">{item.emoji}</div>
          <div className="menu-body">
            <h3>{item.label}</h3>
            <p className="menu-meta">{money(item.amount)} · +{item.stars}★</p>
          </div>
          <button className="btn btn-primary btn-sm" disabled={busy === item.label} onClick={() => void buy(item)}>
            {busy === item.label ? "…" : "Pay"}
          </button>
        </div>
      ))}
    </div>
  )
}

// ─── Rewards ──────────────────────────────────────────────────────────────────

function Rewards({ onFlash }: { onFlash: (m: string) => void }) {
  return (
    <section className="section">
      <LoyaltyCard />
      <h2 className="section-title">Redeem your stars</h2>
      <div className="reward-grid">
        {REWARDS.map((r) => (
          <RewardCard key={r.id} reward={r} onFlash={onFlash} />
        ))}
      </div>
    </section>
  )
}

function RewardCard({ reward, compact, onFlash }: { reward: Reward; compact?: boolean; onFlash?: (m: string) => void }) {
  const { customer, setCustomer, refreshActivity } = useAuth()
  const [busy, setBusy] = useState(false)
  const affordable = customer ? customer.stars >= reward.cost : false

  const redeem = async () => {
    if (!customer) return
    setBusy(true)
    try {
      const updated = await redeemReward(customer, reward)
      setCustomer(updated)
      await refreshActivity()
      onFlash?.(`Enjoy your ${reward.name}! ${reward.emoji}`)
    } catch (e) {
      onFlash?.((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`reward-card${compact ? " compact" : ""}`}>
      <div className="reward-emoji">{reward.emoji}</div>
      <div className="reward-body">
        <h3>{reward.name}</h3>
        {!compact && <p className="reward-desc">{reward.description}</p>}
        <p className="reward-cost"><span className="star">★</span> {reward.cost} stars</p>
      </div>
      {!compact && onFlash && (
        <button className="btn btn-primary btn-sm" disabled={!affordable || busy} onClick={() => void redeem()}>
          {busy ? "…" : affordable ? "Redeem" : "Not enough"}
        </button>
      )}
    </div>
  )
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function Profile() {
  const { customer, activity } = useAuth()
  if (!customer) return null
  return (
    <section className="section">
      <LoyaltyCard />
      <ProfileEditor />
      <h2 className="section-title">Recent activity</h2>
      {activity.length === 0 ? (
        <p className="empty">No activity yet. Order a coffee to start earning stars.</p>
      ) : (
        <ul className="activity">
          {activity.map((a) => (
            <li className="activity-row" key={a.id}>
              <span className="activity-emoji">{a.emoji}</span>
              <div className="activity-text">
                <span className="activity-label">{a.label}</span>
                <span className="activity-date">{new Date(a.created_at).toLocaleString()}</span>
              </div>
              <span className={`activity-stars ${a.kind}`}>
                {a.stars > 0 ? `+${a.stars}` : a.stars}★
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ProfileEditor() {
  const { customer, setCustomer } = useAuth()
  const [name, setName] = useState(customer?.name ?? "")
  const [bio, setBio] = useState<RichTextDoc | null>(customer?.bio ?? null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!customer) return null

  const dirty =
    name.trim() !== customer.name || JSON.stringify(bio) !== JSON.stringify(customer.bio ?? null)

  const save = async () => {
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      const updated = await updateProfile(customer.id, {
        name: name.trim() || customer.name,
        bio,
      })
      setCustomer(updated)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2200)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="profile-editor">
      <h2 className="section-title">Your profile</h2>
      <div className="field">
        <label htmlFor="pe-name">Name</label>
        <input id="pe-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      </div>
      <div className="field">
        <label htmlFor="pe-bio">Bio</label>
        <RichTextEditor
          value={bio}
          onChange={setBio}
          editable
          documentKey={customer.id}
          contentEditableId="pe-bio"
          placeholder="Tell us about your coffee taste…"
        />
      </div>
      {error && <p className="auth-error">{error}</p>}
      <div className="profile-editor-actions">
        <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
        </button>
      </div>
    </div>
  )
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function AuthScreen({ intent }: { intent: View }) {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<"signin" | "signup">("signup")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const err = mode === "signup" ? await signUp(name || email.split("@")[0]!, email, password) : await signIn(email, password)
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <img src="/logo.svg" alt="" className="auth-logo" />
        <h2>{mode === "signup" ? "Join Supabucks" : "Welcome back"}</h2>
        <p className="auth-sub">
          {intent === "rewards" ? "Sign in to redeem your stars." : "Sign in to see your stars and rewards."}
        </p>
        <div className="auth-tabs">
          <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Create account</button>
          <button className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>Sign in</button>
        </div>
        <form onSubmit={submit} className="auth-form">
          {mode === "signup" && (
            <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          )}
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={6} />
          {error && <p className="auth-error">{error}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
            {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  )
}
