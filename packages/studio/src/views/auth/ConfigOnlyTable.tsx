import React from "react"
import { SettingsTable, type SettingRow } from "./AuthSettingsTable.js"
import type { SettingSpec } from "./CloudAuthParts.js"

/**
 * The read-only form of a Cloud settings table, for a host Studio cannot read these values from.
 * The auth server's public settings report only a handful of values, and no route reports the rest,
 * so each row names the supatype.config.ts key that sets it instead of guessing a value.
 */

const SELF_HOST_VALUE = "Set in supatype.config.ts"
const CLOUD_VALUE = "Not available here"

function configRow(spec: SettingSpec, cloud: boolean): SettingRow {
  return { label: spec.label, value: cloud ? CLOUD_VALUE : SELF_HOST_VALUE, on: false, fromDotEnv: false, configKey: spec.path }
}

export function ConfigOnlyTable({ title, specs, cloud }: { title: string; specs: SettingSpec[]; cloud: boolean }): React.ReactElement {
  return <SettingsTable title={title} rows={specs.map((spec) => configRow(spec, cloud))} cloud={cloud} />
}
