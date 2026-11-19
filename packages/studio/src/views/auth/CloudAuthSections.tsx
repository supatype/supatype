import React from "react"
import { groupRequiredSecretKeys, SMS_PROVIDERS } from "@supatype/types"
import { fieldOf, SamlKeyRow, SecretRow, SpecTable, usePendingChoice, type CloudAuthEditor, type PendingChoiceSpec } from "./CloudAuthParts.js"
import { ANONYMOUS_SPECS, MFA_SPECS, PHONE_COMMON_SPECS, SAML_SPECS, SESSION_SPECS, smsProviderFields } from "./authGroupSpecs.js"

/**
 * The Configuration page's sections for sessions, MFA, anonymous and phone sign-in, and SAML on
 * Cloud. Each is a table of the shared setting rows, saved per environment.
 */

const PROVIDER_PATH = "auth.phone.provider"

const PHONE_CHOICE: PendingChoiceSpec = {
  path: PROVIDER_PATH,
  secretKeys: (choice) => {
    const provider = SMS_PROVIDERS.find((name) => name === choice)
    return provider === undefined ? [] : groupRequiredSecretKeys({ auth: { phone: { provider } } })
  },
}

function Phone({ editor }: { editor: CloudAuthEditor }): React.ReactElement | null {
  const phone = usePendingChoice(editor, PHONE_CHOICE)
  const { view } = phone
  if (view === null) return null
  const chosen = fieldOf(view, PROVIDER_PATH).value
  const fields = smsProviderFields(typeof chosen === "string" ? chosen : null)
  return (
    <SpecTable
      title="Phone sign-in"
      specs={[...PHONE_COMMON_SPECS, ...(fields?.specs ?? [])]}
      editor={phone}
      note="Choose a provider and enter its credential below: the two are saved together."
    >
      {fields !== undefined ? <SecretRow secretKey={fields.secret.key} label={fields.secret.label} editor={phone} reported /> : null}
    </SpecTable>
  )
}

function Saml({ editor }: { editor: CloudAuthEditor }): React.ReactElement {
  return (
    <SpecTable title="SAML single sign-on" specs={SAML_SPECS} editor={editor}>
      <SamlKeyRow />
    </SpecTable>
  )
}

export function CloudAuthSections({ editor }: { editor: CloudAuthEditor }): React.ReactElement {
  return (
    <>
      <SpecTable title="Sessions and security" specs={SESSION_SPECS} editor={editor} />
      <SpecTable title="Multi-factor authentication" specs={MFA_SPECS} editor={editor} note="Phone factors need a phone provider below." />
      <SpecTable title="Anonymous sign-in" specs={ANONYMOUS_SPECS} editor={editor} />
      <Phone editor={editor} />
      <Saml editor={editor} />
    </>
  )
}
