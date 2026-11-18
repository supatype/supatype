import React from "react"
import { usePlatform } from "../../hooks/usePlatform.js"
import { CloudAttackProtection } from "./CloudAttackProtection.js"
import { useCloudEnvironment } from "./CloudAuthParts.js"
import { ConfigOnlyTable } from "./ConfigOnlyTable.js"
import { CAPTCHA_SPECS, PASSWORD_SPECS, RATE_LIMIT_SPECS } from "./authGroupSpecs.js"

/**
 * CAPTCHA, password rules and rate limits. Editable per environment on Cloud. On self-host it is
 * read-only for now: the auth server reports none of these, so each row names its config key.
 */

function howToChange(cloud: boolean): string {
  return cloud
    ? "Attack protection is managed by Supatype Cloud for this project and cannot be changed from Studio here."
    : "Set these under auth in supatype.config.ts, and the CAPTCHA secret as auth.captcha.secret: env(\"NAME\"). Studio cannot read or change them yet. Rate limits take effect after the auth server restarts."
}

export function AttackProtectionView(): React.ReactElement {
  const environment = useCloudEnvironment()
  return environment !== null ? <CloudAttackProtection environment={environment} /> : <ReadOnlyAttackProtection />
}

function ReadOnlyAttackProtection(): React.ReactElement {
  const cloud = usePlatform().platformUrl !== undefined
  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground">Attack Protection</h1>
      <p className="text-sm text-muted-foreground">{howToChange(cloud)}</p>
      <ConfigOnlyTable title="CAPTCHA" specs={CAPTCHA_SPECS} cloud={cloud} />
      <ConfigOnlyTable title="Passwords" specs={PASSWORD_SPECS} cloud={cloud} />
      <ConfigOnlyTable title="Rate limits" specs={RATE_LIMIT_SPECS} cloud={cloud} />
    </div>
  )
}
