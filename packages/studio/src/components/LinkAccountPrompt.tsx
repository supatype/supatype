import React, { useState } from "react"
import { useStudioCapability } from "../hooks/useStudioCapability.js"
import { useLinkAccount } from "../hooks/useLinkAccount.js"
import { useProjectRowsOnScreen } from "./ElevatedModeBanner.js"
import { ErrorBanner } from "./ErrorBanner.js"
import { Button, Card, Input } from "./ui.js"

/** Reload Studio once linked, so every view reads again as the member. */
function reloadStudio(): void {
  window.location.reload()
}

/**
 * Asks a Cloud member to link their login for this project, where project rows would be.
 *
 * On Cloud a member acts as their linked project user, so the project's own access rules apply to
 * them. A member with no link is refused project data rather than shown everything (RD2), and this
 * is what tells them why, and fixes it. Shown only while a view that puts project rows on screen is
 * mounted (`useShowsProjectRows`), only to a caller acting as themselves, and only where the host
 * reports links at all: an elevated admin sees data regardless, and on self-host the caller already
 * is a project user.
 */
export function LinkAccountPrompt({ onLinked = reloadStudio }: { onLinked?: () => void }): React.ReactElement | null {
  const { mode, identityLink } = useStudioCapability()
  const rowsOnScreen = useProjectRowsOnScreen()
  if (mode !== "self" || identityLink?.linked !== false || !rowsOnScreen) return null
  return <LinkAccountForm onLinked={onLinked} />
}

function LinkAccountForm({ onLinked }: { onLinked: () => void }): React.ReactElement {
  const { state, link } = useLinkAccount(onLinked)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  function submit(event: React.FormEvent): void {
    event.preventDefault()
    void link(email.trim(), password)
  }

  return (
    <Card className="mb-4 p-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Link your account to see this project's data</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Studio shows you this project's data as its own access rules show it to you. Sign in once with
            your login for this project, using the same email as your Supatype account.
          </p>
        </div>
        <Input name="email" type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input name="password" type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {state.status === "error" ? <ErrorBanner message={state.message} /> : null}
        <div>
          <Button type="submit" variant="primary" disabled={state.status === "working"}>
            {state.status === "working" ? "Linking…" : "Link account"}
          </Button>
        </div>
      </form>
    </Card>
  )
}
