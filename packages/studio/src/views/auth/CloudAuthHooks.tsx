import React from "react"
import { CloudAuthPage, SecretRow, SpecTable, useCloudAuthEditor } from "./CloudAuthParts.js"
import { HOOK_NAMES, HOOK_TITLES, hookSpecs } from "./authGroupSpecs.js"

/**
 * Auth hooks for one environment on Cloud: one section per hook with its switch, URI and signing
 * secret, read and saved through the control plane.
 */

const INTRO =
  "A value saved here wins over supatype.config.ts for this environment until you reset it. The URI is a project edge function's https URL, or pg-functions://postgres/<schema>/<function>. The secret is a v1,whsec_... signing secret, with | between several while rotating."

export function CloudAuthHooks({ environment }: { environment: string }): React.ReactElement {
  const editor = useCloudAuthEditor(environment)
  return (
    <CloudAuthPage title="Auth Hooks" environment={environment} intro={INTRO} editor={editor}>
      {HOOK_NAMES.map((name) => (
        <SpecTable key={name} title={HOOK_TITLES[name]} specs={hookSpecs(name)} editor={editor}>
          <SecretRow secretKey={`hooks.${name}.secrets`} label={`${HOOK_TITLES[name]} hook`} editor={editor} reported />
        </SpecTable>
      ))}
    </CloudAuthPage>
  )
}
