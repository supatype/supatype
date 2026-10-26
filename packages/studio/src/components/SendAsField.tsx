import React from "react"
import type { SendAsState } from "../hooks/useSendAs.js"
import { isSendAs, SEND_AS_LABELS } from "../lib/send-as.js"
import { Input, Select } from "./ui.js"

/**
 * Who a request being built is sent as (`send-as.ts`): the signed-in user by default, anonymous,
 * the service role for a role that may have it, or a pasted token, which starts as the user's own.
 */
export function SendAsField({ sendAs }: { sendAs: SendAsState }): React.ReactElement {
  return (
    <div className="mb-3 space-y-2">
      <div className="flex items-center gap-2">
        <label htmlFor="send-as" className="text-[0.7rem] text-muted-foreground uppercase">Send as</label>
        <Select
          id="send-as"
          aria-label="Send as"
          className="text-xs"
          value={sendAs.choice}
          onChange={(e) => { if (isSendAs(e.target.value)) sendAs.setChoice(e.target.value) }}
        >
          {sendAs.choices.map((c) => <option key={c} value={c}>{SEND_AS_LABELS[c]}</option>)}
        </Select>
      </div>
      {sendAs.choice === "token" ? (
        <Input
          aria-label="Bearer token"
          value={sendAs.token}
          onChange={(e) => { sendAs.setToken(e.target.value) }}
          placeholder="eyJ..."
          className="font-mono text-xs"
        />
      ) : null}
    </div>
  )
}
