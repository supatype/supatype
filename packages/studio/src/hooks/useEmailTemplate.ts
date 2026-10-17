import { useCallback, useEffect, useState } from "react"
import type { SupatypeClient } from "@supatype/client"
import { isJsonObject, readJsonObject } from "../lib/json.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"

/**
 * One email template, as `/auth/v1/admin/template/:type` serves it.
 *
 * The auth server keeps a template saved from Studio in the database and says so: `saved` is true
 * while a saved edit is in force, with `saved_at` when it was saved. DELETE removes the edit and
 * answers with the configured or built-in template that is in force again.
 */
export interface EmailTemplate {
  subject: string
  content: string
  /** When the saved edit in force was saved, or null when the configured or default template is. */
  savedAt: string | null
}

export interface EmailTemplateState {
  template: EmailTemplate
  setSubject(subject: string): void
  setContent(update: (content: string) => string): void
  loading: boolean
  busy: boolean
  error: string | null
  save(): Promise<void>
  reset(): Promise<void>
}

const EMPTY: EmailTemplate = { subject: "", content: "", savedAt: null }

/** Read defensively: an older server sends `body` rather than `content`, and no `saved`. */
export function templateFromResponse(raw: unknown): EmailTemplate {
  const body = isJsonObject(raw) ? raw : {}
  const text = (key: string): string => {
    const value = body[key]
    return typeof value === "string" ? value : ""
  }
  const savedAt = body["saved"] === true && typeof body["saved_at"] === "string" ? body["saved_at"] : null
  return { subject: text("subject"), content: text("content") || text("body"), savedAt }
}

/** The server's own reason for refusing a request (`msg`), or the status when it gives none. */
export async function refusalMessage(res: Response, action: string): Promise<string> {
  // A body that is not JSON reads as `{}`: the status is all there is to say.
  const body = await readJsonObject(res)
  for (const key of ["msg", "message", "error_description"]) {
    const value = body[key]
    if (typeof value === "string" && value !== "") return value
  }
  return `${action} failed: ${res.status}`
}

/** Send one request for the template and answer with what the server says is now in force. */
async function templateRequest(
  client: SupatypeClient,
  type: string,
  action: string,
  init: RequestInit = {},
): Promise<EmailTemplate> {
  const res = await fetch(`${client.url}/auth/v1/admin/template/${type}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...studioGatewayHeaders(), ...studioAuthHeaders(client) },
  })
  if (!res.ok) throw new Error(await refusalMessage(res, action))
  return templateFromResponse(await res.json())
}

interface Setters {
  setTemplate(template: EmailTemplate): void
  setLoading(loading: boolean): void
  setError(error: string | null): void
}

/** Load the template whenever the type changes, ignoring an answer for a type no longer shown. */
function useTemplateLoad(client: SupatypeClient, type: string, { setTemplate, setLoading, setError }: Setters): void {
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    templateRequest(client, type, "Load")
      .then((loaded) => !cancelled && setTemplate(loaded))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [client, type, setTemplate, setLoading, setError])
}

export function useEmailTemplate(client: SupatypeClient, type: string): EmailTemplateState {
  const [template, setTemplate] = useState<EmailTemplate>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useTemplateLoad(client, type, { setTemplate, setLoading, setError })

  const run = useCallback(async (action: string, init: RequestInit) => {
    setBusy(true)
    setError(null)
    try {
      setTemplate(await templateRequest(client, type, action, init))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [client, type])

  return {
    template,
    setSubject: (subject) => setTemplate((t) => ({ ...t, subject })),
    setContent: (update) => setTemplate((t) => ({ ...t, content: update(t.content) })),
    loading,
    busy,
    error,
    save: () => run("Save", { method: "PUT", body: JSON.stringify({ subject: template.subject, content: template.content }) }),
    reset: () => run("Reset", { method: "DELETE" }),
  }
}
