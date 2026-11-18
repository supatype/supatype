import React from "react"
import { CloudAuthPage, SecretRow, SpecTable, useCloudAuthEditor } from "./CloudAuthParts.js"
import { CAPTCHA_SPECS, PASSWORD_SPECS, RATE_LIMIT_SPECS } from "./authGroupSpecs.js"

/**
 * Attack protection for one environment on Cloud: CAPTCHA, password rules and the auth rate limits,
 * read and saved through the control plane like the Configuration page.
 */

const INTRO = "A value saved here wins over supatype.config.ts for this environment until you reset it."
const CAPTCHA_NOTE = "Set the provider's secret key first: turning CAPTCHA on without one is refused."
const RATE_NOTE = "Rate limits take effect after this environment's auth server restarts. Saving rolls it automatically."

export function CloudAttackProtection({ environment }: { environment: string }): React.ReactElement {
  const editor = useCloudAuthEditor(environment)
  return (
    <CloudAuthPage title="Attack Protection" environment={environment} intro={INTRO} editor={editor}>
      <SpecTable title="CAPTCHA" specs={CAPTCHA_SPECS} editor={editor} note={CAPTCHA_NOTE}>
        <SecretRow secretKey="captcha.secret" label="CAPTCHA" editor={editor} reported />
      </SpecTable>
      <SpecTable title="Passwords" specs={PASSWORD_SPECS} editor={editor} />
      <SpecTable title="Rate limits" specs={RATE_LIMIT_SPECS} editor={editor} note={RATE_NOTE} />
    </CloudAuthPage>
  )
}
