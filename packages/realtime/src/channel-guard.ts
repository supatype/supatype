import type { JwtClaims } from "./auth.js"
import type { ChannelDatabase, Queryable } from "./channel-db.js"
import type { ChannelCatalog } from "./channel-catalog.js"
import {
  decideJoin,
  DENIED_BY_DATABASE,
  fetchAccess,
  MAX_TOPIC_LENGTH,
  refusals,
  serviceGrant,
  undeclaredGrant,
  withdrawalRefusal,
  type AccessRow,
  type ChannelGrant,
  type ChannelMode,
  type JoinDecision,
} from "./channel-access.js"
import { sqlState } from "./drop-log.js"
import { refusal, type Refusal } from "./refusal-codes.js"
import type { ChannelSendChecks } from "./send-checks.js"
import type { Subscription } from "./types.js"

/**
 * Decides who may join, send on and track on a channel, by asking the database as the caller.
 *
 * The rules live in the project's schema and are compiled by the engine into
 * `_supatype.realtime_channel_access(topic)`, which this runs as the caller's own role with the
 * caller's own claims (`ChannelDatabase.asCaller`). The server holds no copy of a rule, so it
 * cannot disagree with the schema about one.
 */

/** A socket with no token is judged as the role the anon key would give it: that is all it could be. */
const ANONYMOUS: JwtClaims = { role: "anon" }

/** What a re-check found for one held channel: its new grant, or the reason it is withdrawn. */
export type RecheckOutcome = { channel: string; grant: ChannelGrant } | { channel: string; withdrawn: Refusal }

/** Which held channels a re-check covers. */
export type RecheckScope =
  | { kind: "all" }
  | { kind: "declared" }
  | { kind: "declarations"; names: ReadonlySet<string> }

/** True when the re-check `scope` covers `sub`. A subscription with no recorded grant is never covered. */
export function inScope(scope: RecheckScope, sub: Subscription): boolean {
  if (sub.access === undefined) return false
  switch (scope.kind) {
    case "all":
      return true
    case "declared":
      return sub.access.declaration !== null
    case "declarations":
      return sub.access.declaration !== null && scope.names.has(sub.access.declaration)
  }
}

function isServiceRole(claims: JwtClaims | null): boolean {
  return claims?.role === "service_role"
}

export class ChannelGuard {
  constructor(
    private readonly db: ChannelDatabase,
    private readonly catalog: ChannelCatalog,
    /** A shared instance cannot answer for a project: see {@link authorizeJoin}. */
    private readonly sharedInstance: boolean,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Decide a join, with one database session at most and none for the service role.
   *
   * Fails closed. If the catalog cannot be read or the database does not answer, the join is
   * refused with a retryable message: a declared channel has no check after the join, so admitting
   * on an error would hand the channel to whoever arrived while the database was down (P6). Only a
   * database that has none of the functions (a project that never opted in) is read as "nothing is
   * declared".
   *
   * On a shared instance one database holds every project's schemas and the channel functions are
   * per database, so none of them can answer for one project (P7). A join asking for privacy is
   * refused rather than silently admitted as if it were enforced; any other join is as it always was.
   */
  async authorizeJoin(claims: JwtClaims | null, topic: string, isPrivate: boolean): Promise<JoinDecision> {
    if (topic.length > MAX_TOPIC_LENGTH) return { admitted: false, ...refusal("refused", refusals.tooLong(topic.length)) }
    const now = Date.now()
    if (this.sharedInstance) {
      return isPrivate
        ? { admitted: false, ...refusal("shared_instance", refusals.sharedInstance) }
        : { admitted: true, grant: undeclaredGrant(topic, "open", now) }
    }
    if (isServiceRole(claims)) return { admitted: true, grant: serviceGrant(now) }
    try {
      return await this.decide(claims, topic, isPrivate, now)
    } catch (err) {
      this.log(`could not check access to a channel (SQLSTATE ${sqlState(err)}); refusing the join`)
      return { admitted: false, ...refusal("unavailable", refusals.unreachable(topic)) }
    }
  }

  private async decide(claims: JwtClaims | null, topic: string, isPrivate: boolean, now: number): Promise<JoinDecision> {
    const state = await this.catalog.current()
    const mode = this.catalog.effectiveMode(state)
    const row = state.supported
      ? await this.db.asCaller(claims ?? ANONYMOUS, (q) => fetchAccess(q, topic))
      : null
    return decideJoin(topic, row, { mode, isPrivate, now })
  }

  /**
   * Judge every channel in `subs` again, as `claims`, in one session. Throws when the database
   * cannot answer: what to do then depends on why it was asked, so the caller decides.
   *
   * The service role is answered without the database, as at join.
   */
  async recheck(claims: JwtClaims | null, subs: readonly Subscription[]): Promise<RecheckOutcome[]> {
    if (this.sharedInstance || subs.length === 0) return []
    const now = Date.now()
    if (isServiceRole(claims)) return subs.map((sub) => ({ channel: sub.channel, grant: serviceGrant(now) }))
    const state = await this.catalog.current()
    const mode = this.catalog.effectiveMode(state)
    const rows = state.supported
      ? await this.db.asCaller(claims ?? ANONYMOUS, (q) => this.fetchAll(q, subs))
      : subs.map((): AccessRow | null => null)
    return subs.map((sub, i) => this.outcomeOf(sub, rows[i] ?? null, mode, now))
  }

  /**
   * One answer per channel in one transaction. A rule the database refuses to run aborts the
   * transaction, so each question sits in a savepoint that is rolled back when it is refused, and
   * one channel's refusal does not take the others' answers with it.
   */
  private async fetchAll(q: Queryable, subs: readonly Subscription[]): Promise<Array<AccessRow | null>> {
    const rows: Array<AccessRow | null> = []
    for (const sub of subs) {
      await q.query("SAVEPOINT channel_access")
      const row = await fetchAccess(q, sub.channel)
      await q.query(row === DENIED_BY_DATABASE ? "ROLLBACK TO SAVEPOINT channel_access" : "RELEASE SAVEPOINT channel_access")
      rows.push(row)
    }
    return rows
  }

  private outcomeOf(sub: Subscription, row: AccessRow | null, mode: ChannelMode, now: number): RecheckOutcome {
    const decision = decideJoin(sub.channel, row, {
      mode,
      isPrivate: sub.access?.openedAsPrivate === true,
      now,
    })
    if (decision.admitted) return { channel: sub.channel, grant: decision.grant }
    return { channel: sub.channel, withdrawn: withdrawalRefusal(sub.channel, row) }
  }

  /**
   * The content checks that apply to a broadcast on a channel granted under `declaration`.
   *
   * With the catalog not loaded the answer is `unreadable`, which refuses: a broadcast is only ever
   * asked about after a join, and a join needs the catalog, so this is a catalog that was lost and
   * not one that never was.
   */
  sendChecksFor(declaration: string | null): ChannelSendChecks {
    if (declaration === null) return { state: "none" }
    const state = this.catalog.peek()
    if (state === null) return { state: "unreadable" }
    return state.sendChecks.get(declaration) ?? { state: "none" }
  }

  /** The declarations whose rules read the table `key` (`schema.table`): a change to it may change who is admitted. */
  declarationsReading(key: string): ReadonlySet<string> | undefined {
    return this.catalog.peek()?.readers.get(key)
  }
}
