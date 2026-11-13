import { useCallback, useEffect, useState } from "react"
import type { AuthSettingValue } from "@supatype/types"
import {
  isArrayOf,
  isBoolean,
  isNumber,
  isOneOf,
  isRecordOf,
  isShape,
  isString,
  nullable,
  type Guard,
} from "../lib/json.js"
import { membershipRequest, type MembershipInit } from "../lib/membership-request.js"
import { useAdminClient } from "./useAdminClient.js"

/** One setting as the control plane reports it: the value in force, and where it came from. */
export interface AuthFieldView {
  value: AuthSettingValue | null
  source: "default" | "code" | "studio"
  codeValue: AuthSettingValue | null
  /** A Studio value masks a different pushed value. */
  differsFromCode: boolean
  updatedAt: string | null
  updatedBy: string | null
}

/** One secret: whether it is set and its last four characters, never the value. */
export interface AuthSecretView {
  set: boolean
  fingerprint: string | null
  source: "code" | "studio" | null
  updatedAt: string | null
  updatedBy: string | null
}

export interface AuthSettingsView {
  environment: string
  version: number
  /** Null until the running server was seen to match. */
  appliedVersion: number | null
  appliedAt: string | null
  fields: Record<string, AuthFieldView>
  secrets: Record<string, AuthSecretView>
  /** Provider name to the callback URL to register with it. */
  callbacks: Record<string, string>
  /** Always in the redirect allow list, not removable. */
  platformRedirectUrls: string[]
  /** Mail goes through the platform sender (no provider of the project's own). */
  platformSender: boolean
  mailHourlyCap: number | null
}

/** What a save sends: settings to set, paths whose Studio value is dropped, and secrets. */
export interface AuthSettingsEdit {
  set?: Record<string, AuthSettingValue>
  reset?: string[]
  /** A string sets the secret; null removes it. */
  secrets?: Record<string, string | null>
}

const isSettingValue: Guard<AuthSettingValue> = (value: unknown): value is AuthSettingValue =>
  isString(value) || isNumber(value) || isBoolean(value) || isArrayOf(isString)(value)

const isStringList = isArrayOf(isString)

const isFieldView: Guard<AuthFieldView> = isShape({
  value: nullable(isSettingValue),
  source: isOneOf(["default", "code", "studio"] as const),
  codeValue: nullable(isSettingValue),
  differsFromCode: isBoolean,
  updatedAt: nullable(isString),
  updatedBy: nullable(isString),
})

const isSecretView: Guard<AuthSecretView> = isShape({
  set: isBoolean,
  fingerprint: nullable(isString),
  source: nullable(isOneOf(["code", "studio"] as const)),
  updatedAt: nullable(isString),
  updatedBy: nullable(isString),
})

/** True for the control plane's `AuthSettingsView`; a body of any other shape is refused. */
export const isAuthSettingsView: Guard<AuthSettingsView> = isShape({
  environment: isString,
  version: isNumber,
  appliedVersion: nullable(isNumber),
  appliedAt: nullable(isString),
  fields: isRecordOf(isFieldView),
  secrets: isRecordOf(isSecretView),
  callbacks: isRecordOf(isString),
  platformRedirectUrls: isStringList,
  platformSender: isBoolean,
  mailHourlyCap: nullable(isNumber),
})

export interface UseCloudAuthSettingsReturn {
  view: AuthSettingsView | null
  loading: boolean
  /** Why the last call failed, verbatim from the server. */
  error: string | null
  /** True when the server accepted the change; the view then holds what it answered. */
  save: (edit: AuthSettingsEdit) => Promise<boolean>
}

/** The route's request body: only the parts an edit names. */
function bodyOf(edit: AuthSettingsEdit): Record<string, unknown> {
  return {
    ...(edit.set !== undefined && { set: edit.set }),
    ...(edit.reset !== undefined && { reset: edit.reset }),
    ...(edit.secrets !== undefined && { secrets: edit.secrets }),
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * One environment's auth settings on Cloud, read and changed through the control plane's
 * `/environments/:env/auth` route. The server decides what is valid and who may write; this hook
 * only carries its answers. With no environment it asks for nothing.
 */
export function useCloudAuthSettings(environment: string | undefined): UseCloudAuthSettingsReturn {
  const client = useAdminClient()
  const [view, setView] = useState<AuthSettingsView | null>(null)
  const [loading, setLoading] = useState(environment !== undefined)
  const [error, setError] = useState<string | null>(null)
  const path = `/environments/${encodeURIComponent(environment ?? "")}/auth`

  const request = useCallback(
    (init?: MembershipInit): Promise<AuthSettingsView> => membershipRequest(client, path, isAuthSettingsView, init),
    [client, path],
  )

  useEffect(() => {
    if (environment === undefined) return
    let cancelled = false
    setLoading(true)
    setError(null)
    request()
      .then((next) => { if (!cancelled) setView(next) })
      .catch((err: unknown) => { if (!cancelled) setError(messageOf(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [request, environment])

  const save = useCallback(
    async (edit: AuthSettingsEdit): Promise<boolean> => {
      setError(null)
      try {
        setView(await request({ method: "PUT", body: bodyOf(edit) }))
        return true
      } catch (err) {
        setError(messageOf(err))
        return false
      }
    },
    [request],
  )

  return { view, loading, error, save }
}
