import { useState } from "react"
import { useAdminClient } from "./useAdminClient.js"
import { useStudioCapability } from "./useStudioCapability.js"
import { signedInToken } from "../lib/studio-auth-headers.js"
import { sendAsChoices, sendAsHeaders, type SendAs } from "../lib/send-as.js"

/** A request builder's send-as choice, and the headers it puts on the request. */
export interface SendAsState {
  choice: SendAs
  setChoice: (choice: SendAs) => void
  /** The pasted token, which starts as the signed-in user's so it can be edited rather than found. */
  token: string
  setToken: (token: string) => void
  choices: SendAs[]
  headers: () => Record<string, string>
  /** Sending as "Me" on a host that has links, with none yet: the request would be refused. */
  needsLink: boolean
}

export function useSendAs(): SendAsState {
  const client = useAdminClient()
  const { canElevate, identityLink } = useStudioCapability()
  const signedIn = signedInToken(client)
  const [choice, setChoice] = useState<SendAs>("me")
  const [token, setToken] = useState(signedIn)
  return {
    choice,
    setChoice,
    token,
    setToken,
    choices: sendAsChoices(canElevate),
    headers: () => sendAsHeaders(choice, signedIn, token),
    needsLink: choice === "me" && identityLink?.linked === false,
  }
}
