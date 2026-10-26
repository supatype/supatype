import { test } from "@playwright/test"

/**
 * Open defects this suite knows about, by their id in Pre-Launch-Verification-Register. An id is
 * removed here, and from every test that names it, when its fix lands (fixed so far: T1-N1 to
 * T1-N4, A3-N3, T2-N1 to T2-N11, M06, P03, V-N1, V-N2, TEST-1-N1, TEST-1-N2, TRAIN-FIX-N1).
 *
 * A test that asserts the correct behaviour while one of these is open is marked expected-fail
 * with the ids that break it. Playwright then requires it to fail: once the fix lands the test
 * passes, Playwright reports "expected to fail, but passed", and the run goes red until the mark
 * is removed. So the suite is green today, and a fix cannot land without the test that proves it.
 */
export const OPEN_DEFECTS = {} as const satisfies Record<string, string>

export type DefectId = keyof typeof OPEN_DEFECTS

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
