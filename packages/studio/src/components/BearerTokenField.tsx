import React from "react"
import { Button, Input } from "./ui.js"

/**
 * The Bearer token a request builder sends, starting as the signed-in Studio user's own.
 *
 * Editable, so a request can be tried as another user or with a key pasted in, and one click puts
 * the editor's own token back.
 */
export function BearerTokenField({ value, onChange, signedIn }: { value: string; onChange: (token: string) => void; signedIn: string }): React.ReactElement {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <label htmlFor="bearer-token" className="block text-[0.7rem] text-muted-foreground uppercase">Authorization Bearer Token</label>
        {signedIn !== "" && value !== signedIn ? (
          <Button size="xs" variant="ghost" onClick={() => { onChange(signedIn) }}>Use my session</Button>
        ) : null}
      </div>
      <Input id="bearer-token" value={value} onChange={(e) => { onChange(e.target.value) }} placeholder="eyJ..." className="font-mono text-xs" />
    </div>
  )
}
