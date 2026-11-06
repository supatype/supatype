import React, { useCallback, useEffect, useState } from "react"
import { Badge, Button, Dialog, Table } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import type { SsoProviderActions } from "../../hooks/useSsoProviders.js"
import {
  unreachable,
  verificationOf,
  type DomainTarget,
  type DomainVerification,
  type SsoProvider,
  type VerifyOutcome,
} from "../../lib/sso-providers.js"
import { CopyRow } from "./CopyRow.js"

/**
 * A provider's email domains and their DNS verification. A domain routes sign-ins as soon as it is
 * added; verifying it (a TXT record at `_supatype-challenge.<domain>`) is what lets a SAML login
 * link to an account that already has its email, which is refused until then.
 */

/** What the page says about verification, wherever a provider has domains. */
export function LinkingNote(): React.ReactElement {
  return (
    <p className="text-xs text-muted-foreground">
      Domains route sign-ins as soon as they are added. Until a domain is verified, a SAML login whose email already has
      an account is refused, so no duplicate account is made; a login with no account signs in normally. Once it is
      verified, such logins link to the existing account.
    </p>
  )
}

/** Each domain with its state, and Verify beside an unverified one when `verify` is given. */
export function DomainList({ provider, verify }: {
  provider: SsoProvider
  verify: ((target: DomainTarget) => void) | null
}): React.ReactElement {
  if (provider.domains.length === 0) return <span className="text-muted-foreground">None</span>
  return (
    <div className="space-y-1">
      {provider.domains.map((d) => (
        <div key={d.domain} className="flex flex-wrap items-center gap-1.5">
          <span>{d.domain}</span>
          <Badge variant={d.verified ? "green" : "yellow"}>{d.verified ? "Verified" : "Unverified"}</Badge>
          {verify && !d.verified && (
            <Button size="xs" variant="ghost" aria-label={`Verify ${d.domain}`} onClick={() => { verify({ provider, domain: d.domain }) }}>
              Verify
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

interface DomainCheck {
  checking: boolean
  outcome: VerifyOutcome | null
  check: () => void
}

/** Checks the domain on open and again on `check`; a request that throws is reported as its outcome. */
function useDomainCheck(target: DomainTarget, verify: SsoProviderActions["verifyDomain"]): DomainCheck {
  const [state, setState] = useState<{ checking: boolean; outcome: VerifyOutcome | null }>({ checking: true, outcome: null })
  const check = useCallback((): void => {
    setState((s) => ({ ...s, checking: true }))
    verify(target).then(
      (outcome) => { setState({ checking: false, outcome }) },
      (err: unknown) => { setState({ checking: false, outcome: { error: unreachable(err) } }) },
    )
  }, [target, verify])
  useEffect(() => { check() }, [check])
  return { ...state, check }
}

/** Why the domain is not verified yet: no record at the name, or a record holding something else. */
function notYet(v: DomainVerification): string {
  if (v.found === null || v.found.length === 0) {
    return `No TXT record was found at ${v.challenge.name} yet. A new record can take a while to be seen; check again once it is published.`
  }
  return `DNS holds ${v.found.join(", ")} at ${v.challenge.name}, not the value above.`
}

function CheckResult({ check }: { check: DomainCheck }): React.ReactElement {
  if (check.outcome !== null && "error" in check.outcome) return <ErrorBanner message={check.outcome.error} />
  const verification = verificationOf(check.outcome)
  if (verification?.verified === true) {
    return (
      <p>
        <Badge variant="green">Verified</Badge> {verification.domain} is verified. SAML logins on it whose email already
        has an account now link to that account.
      </p>
    )
  }
  return <p>{verification === null || check.checking ? "Checking DNS…" : notYet(verification)}</p>
}

/** The record to publish, once the server has issued it. */
function ChallengeRecord({ verification }: { verification: DomainVerification | null }): React.ReactElement | null {
  if (verification === null) return null
  return (
    <Table>
      <tbody>
        <CopyRow label="Name" value={verification.challenge.name} />
        <CopyRow label="Value" value={verification.challenge.value} />
      </tbody>
    </Table>
  )
}

/** The Verify dialog: the TXT record to add, what DNS holds now, and a way to check again. */
export function VerifyDomainDialog({ target, verify, onClose }: {
  target: DomainTarget
  verify: SsoProviderActions["verifyDomain"]
  onClose: () => void
}): React.ReactElement {
  const check = useDomainCheck(target, verify)
  const verification = verificationOf(check.outcome)
  const verified = verification?.verified === true
  const actions = (
    <>
      <Button onClick={onClose}>Close</Button>
      {!verified && <Button variant="primary" disabled={check.checking} onClick={check.check}>Check again</Button>}
    </>
  )
  return (
    <Dialog title={`Verify ${target.domain}`} actions={actions}>
      <p>
        Add this TXT record at the DNS host for {target.domain}, then check again. Once the record is seen the domain
        stays verified, and the record can be removed.
      </p>
      <ChallengeRecord verification={verification} />
      <CheckResult check={check} />
    </Dialog>
  )
}
