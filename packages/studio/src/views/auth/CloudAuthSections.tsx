import React from "react"
import { fieldOf, SamlKeyRow, SecretRow, SpecTable, type CloudAuthEditor } from "./CloudAuthParts.js"
import { ANONYMOUS_SPECS, MFA_SPECS, PHONE_COMMON_SPECS, SAML_SPECS, SESSION_SPECS, smsProviderFields } from "./authGroupSpecs.js"

/**
 * The Configuration page's sections for sessions, MFA, anonymous and phone sign-in, and SAML on
 * Cloud. Each is a table of the shared setting rows, saved per environment.
 */

function Phone({ editor }: { editor: CloudAuthEditor }): React.ReactElement | null {
  const { view } = editor
  if (view === null) return null
  const chosen = fieldOf(view, "auth.phone.provider").value
  const fields = smsProviderFields(typeof chosen === "string" ? chosen : null)
  return (
    <SpecTable
      title="Phone sign-in"
      specs={[...PHONE_COMMON_SPECS, ...(fields?.specs ?? [])]}
      editor={editor}
      note="Choosing a provider needs its credential: the save is refused until the secret below is set."
    >
      {fields !== undefined ? <SecretRow secretKey={fields.secret.key} label={fields.secret.label} editor={editor} reported /> : null}
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
