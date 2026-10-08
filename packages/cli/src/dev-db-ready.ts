/**
 * Waiting for the bundled Postgres once the rest of the stack is up.
 *
 * `up -d` recreates `db` when its definition changed after Postgres was started for the schema
 * push, so `dev` waits for it again. A wait that runs out is a failed start like any other: the
 * dev session is ended, the database's logs are kept, and `dev` exits non-zero with what happened,
 * rather than an `Error` thrown up past all of that.
 */

import type { DockerBrandOptions } from "./docker-runtime.js"
import { exitComposeFailed } from "./self-host-compose.js"

export interface DatabaseReadySteps {
  /** Resolves once Postgres answers; throws when it has not by the deadline. */
  waitHealthy: () => Promise<void>
  /** Save and print the db container's logs. */
  dumpLogs: (reason: string) => void
  /** Release what the dev session holds, as every other failed start does. */
  onFailure?: () => void
  brand?: DockerBrandOptions
}

export async function waitForDatabaseAfterUp(steps: DatabaseReadySteps): Promise<void> {
  try {
    await steps.waitHealthy()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    steps.onFailure?.()
    steps.dumpLogs("the stack came up without Postgres answering")
    exitComposeFailed(
      1,
      `Postgres did not answer again after the rest of the stack came up (${message}).`,
      steps.brand,
    )
  }
}
