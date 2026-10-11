import { test } from "@playwright/test"
import { currentTier, type Tier } from "./stack.js"

/**
 * Open defects this suite knows about, by their id in Pre-Launch-Verification-Register.
 *
 * A test that asserts the correct behaviour while one of these is open is marked expected-fail
 * with the ids that break it. Playwright then requires it to fail: once the fix lands the test
 * passes, Playwright reports "expected to fail, but passed", and the run goes red until the mark
 * is removed. So the suite is green today, and a fix cannot land without the test that proves it.
 */
export const OPEN_DEFECTS = {
  "T1-N1": "the auth server's migration replaces auth.role() after the first push, so Role<> rules never match on a fresh stack",
  "T1-N2": "GraphQL nested relations fail when the related table has a masked column",
  "T1-N3": "realtime column filters compare values as strings",
  "T1-N4": "REST computed columns fail on a table with masked columns (whole-row reference)",
  "A3-N3": "tier 2 serves nothing: the api views are security_invoker and the API roles hold no base-table privilege",
  "T2-N1": "a write through an api view returns the stored values of masked columns",
  "T2-N2": "an update or delete through an api view that RLS refuses still answers with a row",
  "T2-N3": "an insert through an api view skips field write rules",
  "T2-N4": "an insert through an api view ignores column defaults",
  "T2-N5": "tier 2 masks service_role over REST and discards its writes to masked columns",
  "T2-N6": "pg_graphql reflects no model for end users under tier 2",
  "T2-N7": "with supatype_mask dropped on supatype/postgres, stale labels make every masked-column update fail",
  "T2-N8": "realtime takes its mask list from security labels only, which tier 2 does not have",
  "T2-N9": "realtime drops events without logging why",
  "T2-N10": "doctor does not report the api views' options or owner, and a push silently reverts them",
  "T2-N11": "a push to a plain Postgres fails with raw errors and no preflight",
  "M06": "realtime delivers DELETEs of rows the subscriber cannot see, and keys rows by the first column",
  "P03": "realtime does not enforce row-level security on every event",
  "V-N1": "supatype dev pushes with --force, so an unrecognised rename drops the column and its data",
  "V-N2": "supatype dev does not regenerate types in a project made by init",
} as const satisfies Record<string, string>

export type DefectId = keyof typeof OPEN_DEFECTS

/** Which defects break a case, per tier. A tier left out means the case should pass there. */
export type DefectsByTier = Partial<Record<Tier, readonly DefectId[]>>

export function defectsFor(tier: Tier, byTier: DefectsByTier | undefined): readonly DefectId[] {
  return byTier?.[tier] ?? []
}

/**
 * Marks the running test expected-fail when any defect is open for it. Call it first in the test
 * body. The annotation names each id and what it is, so a report says why the test is red today.
 */
export function expectDefects(ids: readonly DefectId[]): void {
  if (ids.length === 0) return
  const why = ids.map((id) => `${id}: ${OPEN_DEFECTS[id]}`).join("; ")
  test.info().annotations.push(...ids.map((id) => ({ type: "open-defect", description: id })))
  test.fail(true, why)
}

/** The defects open for a case in the tier this run is testing. */
export function on(byTier: DefectsByTier): readonly DefectId[] {
  return defectsFor(currentTier(), byTier)
}
