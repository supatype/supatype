import React, { useState } from "react"
import { Badge, Button, Card, ConfirmButton, LoadingRows, PageHeader, Table, TableCard, Td, Th, tableRowClass } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { useAuthSettings } from "../../hooks/useAuthSettings.js"
import {
  useServiceProvider,
  useSsoProviders,
  type ServiceProviderState,
  type SsoProviderActions,
} from "../../hooks/useSsoProviders.js"
import { useStudioCapability } from "../../hooks/useStudioCapability.js"
import { ssoProviderChangesOffered } from "../../lib/capability-offers.js"
import { providerName, type DomainTarget, type SsoProvider, type WriteOutcome } from "../../lib/sso-providers.js"
import { CopyRow } from "./CopyRow.js"
import { DomainList, LinkingNote, VerifyDomainDialog } from "./SsoDomains.js"
import { SsoProviderForm, type ProviderFormTask } from "./SsoProviderForm.js"

/**
 * Single sign-on: the project's SAML identity providers, and the values to give each one.
 *
 * Providers are runtime data in the auth server's database, not config, so they are changed here
 * (or with `supatype sso`) through the auth admin API. That API works while SAML is off, so a
 * provider can be set up before SAML is turned on; the page says when it is off.
 */

function Code({ children }: { children: string }): React.ReactElement {
  return <code className="font-mono text-xs text-foreground">{children}</code>
}

function SamlOffNotice(): React.ReactElement {
  return (
    <Card className="p-4 text-sm text-muted-foreground">
      SAML is off for this project, so nobody can sign in through these providers yet. Turn it on with{" "}
      <Code>auth.sso.saml.enabled: true</Code> in supatype.config.ts (or <Code>SUPATYPE_SAML_ENABLED=true</Code> in
      the project&apos;s .env), then restart <Code>supatype dev</Code>. Providers added now are kept and used once it is on.
    </Card>
  )
}

/** The SP values an identity provider is set up with, as the server's metadata states them. */
function ServiceProviderCard({ sp }: { sp: ServiceProviderState }): React.ReactElement | null {
  if (sp.error !== null) return <ErrorBanner message={sp.error} />
  if (sp.values === null) return null
  return (
    <Card>
      <h3 className="text-sm font-medium text-foreground px-4 pt-4 pb-1">Give these to your identity provider</h3>
      <p className="text-xs text-muted-foreground px-4 pb-2">
        Send a persistent NameID and an <code className="font-mono">email</code> attribute. The metadata URL also serves as the entity ID.
      </p>
      <Table>
        <tbody>
          <CopyRow label="Entity ID and metadata URL" value={sp.values.entityId} />
          <CopyRow label="ACS URL" value={sp.values.acsUrl} />
        </tbody>
      </Table>
    </Card>
  )
}

/** What one row offers: changes for a role that may make them, nothing otherwise. */
interface RowChanges {
  edit: (provider: SsoProvider) => void
  toggle: (provider: SsoProvider) => void
  remove: (provider: SsoProvider) => void
  verify: (target: DomainTarget) => void
}

function removeQuestion(name: string): { title: string; detail: string; answer: string } {
  return {
    title: `Remove SAML provider ${name}?`,
    detail: `Users who signed in through ${name} can no longer sign in that way. Their accounts stay, but they need another way in. Adding the provider again does not reconnect them, because it gets a new ID.`,
    answer: "Remove provider",
  }
}

function RowButtons({ provider, changes }: { provider: SsoProvider; changes: RowChanges }): React.ReactElement {
  return (
    <div className="flex justify-end gap-1.5">
      <Button size="xs" onClick={() => { changes.edit(provider) }}>Edit</Button>
      <Button size="xs" onClick={() => { changes.toggle(provider) }}>{provider.disabled ? "Enable" : "Disable"}</Button>
      <ConfirmButton size="xs" variant="ghost" ask={removeQuestion(providerName(provider))} act={() => { changes.remove(provider) }}>Remove</ConfirmButton>
    </div>
  )
}

function ProviderRow({ provider, changes }: { provider: SsoProvider; changes: RowChanges | null }): React.ReactElement {
  return (
    <tr className={tableRowClass(false)}>
      <Td className="px-4 py-3 font-medium">{providerName(provider)}</Td>
      <Td className="px-4 py-3 font-mono text-xs break-all">{provider.entityId}</Td>
      <Td className="px-4 py-3"><DomainList provider={provider} verify={changes?.verify ?? null} /></Td>
      <Td className="px-4 py-3"><Badge variant={provider.disabled ? "outline" : "green"}>{provider.disabled ? "Disabled" : "Enabled"}</Badge></Td>
      {changes && <Td className="px-4 py-3"><RowButtons provider={provider} changes={changes} /></Td>}
    </tr>
  )
}

function ProvidersTable({ providers, changes }: { providers: SsoProvider[]; changes: RowChanges | null }): React.ReactElement {
  if (providers.length === 0) {
    return <EmptyState title="No SAML providers yet" description="Add the identity provider your users sign in with, from its metadata URL or XML." />
  }
  const head = (
    <>
      <Th className="px-4 py-2.5">Name</Th>
      <Th className="px-4 py-2.5">Entity ID</Th>
      <Th className="px-4 py-2.5">Domains</Th>
      <Th className="px-4 py-2.5">Status</Th>
      {changes && <Th className="px-4 py-2.5"><span className="sr-only">Actions</span></Th>}
    </>
  )
  return (
    <>
      <TableCard head={head}>{providers.map((p) => <ProviderRow key={p.id} provider={p} changes={changes} />)}</TableCard>
      {providers.some((p) => p.domains.length > 0) && <LinkingNote />}
    </>
  )
}

/** What is open over the page: nothing, the add or edit form, or one domain's verification. */
type Panel = { kind: "none" } | { kind: "form"; editing: SsoProvider | null } | { kind: "verify"; target: DomainTarget }

const CLOSED: Panel = { kind: "none" }

interface Changes {
  changes: RowChanges
  actionError: string | null
  close: () => void
  formTask: (editing: SsoProvider | null) => ProviderFormTask
}

/** The row changes and the form task, a refused row change reported where it can be seen. */
function useChanges(actions: SsoProviderActions, open: (panel: Panel) => void): Changes {
  const [actionError, setActionError] = useState<string | null>(null)
  const report = (outcome: Promise<WriteOutcome>): void => {
    setActionError(null)
    outcome.then(setActionError, (err: unknown) => { setActionError(err instanceof Error ? err.message : String(err)) })
  }
  const close = (): void => { open(CLOSED) }
  const changes: RowChanges = {
    edit: (provider) => { open({ kind: "form", editing: provider }) },
    toggle: (provider) => { report(actions.setDisabled(provider, !provider.disabled)) },
    remove: (provider) => { report(actions.remove(provider)) },
    verify: (target) => { open({ kind: "verify", target }) },
  }
  const formTask = (editing: SsoProvider | null): ProviderFormTask => ({
    editing,
    save: (draft) => (editing ? actions.update(editing, draft) : actions.create(draft)),
    close,
  })
  return { changes, actionError, close, formTask }
}

/** The form or the Verify dialog, whichever is open. */
function OpenPanel({ panel, changes, actions }: {
  panel: Panel
  changes: Changes
  actions: SsoProviderActions
}): React.ReactElement | null {
  switch (panel.kind) {
    case "form":
      return <SsoProviderForm task={changes.formTask(panel.editing)} />
    case "verify":
      return <VerifyDomainDialog target={panel.target} verify={actions.verifyDomain} onClose={changes.close} />
    case "none":
      return null
  }
}

export function SsoView(): React.ReactElement {
  const { settings } = useAuthSettings()
  const samlOn = settings?.saml_enabled === true
  const sp = useServiceProvider(samlOn)
  const { state, actions } = useSsoProviders()
  const canChange = ssoProviderChangesOffered(useStudioCapability())
  const [panel, setPanel] = useState<Panel>(CLOSED)
  const edits = useChanges(actions, setPanel)
  const add = canChange ? <Button variant="primary" onClick={() => { setPanel({ kind: "form", editing: null }) }}>Add provider</Button> : undefined

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader title="SSO" action={add} />
      <p className="text-sm text-muted-foreground">SAML 2.0 identity providers your users can sign in with, chosen by their email domain.</p>
      {settings && !samlOn && <SamlOffNotice />}
      <ServiceProviderCard sp={sp} />
      {!canChange && <p className="text-xs text-muted-foreground">Only roles that administer the project can change SSO providers.</p>}
      {state.error !== null && <ErrorBanner message={state.error} />}
      {edits.actionError !== null && <ErrorBanner message={edits.actionError} />}
      {state.providers === null && state.error === null && <LoadingRows />}
      {state.providers && <ProvidersTable providers={state.providers} changes={canChange ? edits.changes : null} />}
      <OpenPanel panel={panel} changes={edits} actions={actions} />
    </div>
  )
}
