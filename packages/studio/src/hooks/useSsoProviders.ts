import { useCallback, useEffect, useState } from "react"
import {
  createBody,
  fetchServiceProvider,
  listSsoProviders,
  providerAddress,
  updateBody,
  verificationOf,
  verifySsoDomain,
  writeSsoProvider,
  type DomainTarget,
  type ProviderWrite,
  type ServiceProviderValues,
  type SsoProvider,
  type SsoProviderDraft,
  type VerifyOutcome,
  type WriteOutcome,
} from "../lib/sso-providers.js"
import { useAdminClient } from "./useAdminClient.js"

export interface SsoProvidersState {
  providers: SsoProvider[] | null
  error: string | null
}

/** The changes the page makes. Each resolves to null once the server took it, else its reason. */
export interface SsoProviderActions {
  create: (draft: SsoProviderDraft) => Promise<WriteOutcome>
  update: (provider: SsoProvider, draft: SsoProviderDraft) => Promise<WriteOutcome>
  setDisabled: (provider: SsoProvider, disabled: boolean) => Promise<WriteOutcome>
  remove: (provider: SsoProvider) => Promise<WriteOutcome>
  /** Check one domain's DNS record; the list is read again once it is verified. Stable across renders. */
  verifyDomain: (target: DomainTarget) => Promise<VerifyOutcome>
}

/** The project's SAML providers, and the writes that change them; the list is read again after each. */
export function useSsoProviders(): { state: SsoProvidersState; actions: SsoProviderActions } {
  const client = useAdminClient()
  const [state, setState] = useState<SsoProvidersState>({ providers: null, error: null })

  const reload = useCallback(async (): Promise<void> => {
    const listed = await listSsoProviders(client)
    setState("error" in listed ? { providers: null, error: listed.error } : { providers: listed.providers, error: null })
  }, [client])

  useEffect(() => { void reload() }, [reload])

  const send = useCallback(async (write: ProviderWrite): Promise<WriteOutcome> => {
    const outcome = await writeSsoProvider(client, write)
    if (outcome === null) await reload()
    return outcome
  }, [client, reload])

  const verifyDomain = useCallback(async (target: DomainTarget): Promise<VerifyOutcome> => {
    const checked = await verifySsoDomain(client, target)
    // Not awaited: the dialog shows the answer now, and the list catches up when it is read.
    if (verificationOf(checked)?.verified === true) void reload()
    return checked
  }, [client, reload])

  const actions: SsoProviderActions = {
    verifyDomain,
    create: (draft) => send({ method: "POST", body: createBody(draft) }),
    update: (provider, draft) => send({ method: "PUT", address: providerAddress(provider), body: updateBody(draft) }),
    setDisabled: (provider, disabled) => send({ method: "PUT", address: providerAddress(provider), body: { disabled } }),
    remove: (provider) => send({ method: "DELETE", address: providerAddress(provider) }),
  }
  return { state, actions }
}

export type ServiceProviderState = { values: ServiceProviderValues | null; error: string | null }

/** The SP values to give an identity provider, read only while SAML is on (the route 404s when off). */
export function useServiceProvider(samlEnabled: boolean): ServiceProviderState {
  const client = useAdminClient()
  const [state, setState] = useState<ServiceProviderState>({ values: null, error: null })

  useEffect(() => {
    if (!samlEnabled) return
    let cancelled = false
    void fetchServiceProvider(client).then((read) => {
      if (cancelled) return
      setState("error" in read ? { values: null, error: read.error } : { values: read, error: null })
    })
    return () => { cancelled = true }
  }, [client, samlEnabled])

  return state
}
