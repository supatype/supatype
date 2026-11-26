import React from "react"
import { usePlatform } from "../../hooks/usePlatform.js"
import { CloudAuthHooks } from "./CloudAuthHooks.js"
import { useCloudEnvironment } from "./CloudAuthParts.js"
import { ConfigOnlyTable } from "./ConfigOnlyTable.js"
import { HOOK_NAMES, HOOK_TITLES, hookSpecs } from "./authGroupSpecs.js"

/**
 * One section per auth hook. Editable per environment on Cloud. On self-host it is read-only for
 * now: the auth server does not report its hooks, so each row names its config key.
 */

function howToChange(cloud: boolean): string {
  return cloud
    ? "Auth hooks are managed by Supatype Cloud for this project and cannot be changed from Studio here."
    : "Set hooks under auth.hooks in supatype.config.ts: a uri (an https URL, or pg-functions://postgres/<schema>/<function>) and secrets: env(\"NAME\") holding a v1,whsec_... signing secret. Studio cannot read or change them yet."
}

export function AuthHooksView(): React.ReactElement {
  const environment = useCloudEnvironment()
  return environment !== null ? <CloudAuthHooks environment={environment} /> : <ReadOnlyAuthHooks />
}

function ReadOnlyAuthHooks(): React.ReactElement {
  const cloud = usePlatform().platformUrl !== undefined
  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground">Auth Hooks</h1>
      <p className="text-sm text-muted-foreground">{howToChange(cloud)}</p>
      {HOOK_NAMES.map((name) => <ConfigOnlyTable key={name} title={HOOK_TITLES[name]} specs={hookSpecs(name)} cloud={cloud} />)}
    </div>
  )
}
