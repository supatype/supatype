import type { ChannelManager, ConnectedClient } from "./channels.js"
import type { ChannelCatalog } from "./channel-catalog.js"
import { tableKey } from "./channel-catalog.js"
import { inScope, type ChannelGuard, type RecheckOutcome, type RecheckScope } from "./channel-guard.js"
import { ChannelRechecker } from "./channel-recheck.js"
import { refusals, type ChannelGrant } from "./channel-access.js"
import { sqlState } from "./drop-log.js"
import type { PresenceEntry, Subscription, WalChange } from "./types.js"

/** How many sockets are re-checked at once: each holds one pooled connection while it is. */
const RECHECK_CONCURRENCY = 8

/** How long changes to a table a channel's rules read are gathered into one re-check. */
const DEBOUNCE_MS = 1000

/** What the enforcer needs the server to do for it: speak to a socket and to a channel. */
export interface EnforcementHooks {
  /** Tell one client why it was refused, naming the channel, so only that channel fails. */
  refuse(client: ConnectedClient, channel: string, message: string): void
  /** Tell the members of `channel` that `entry` left its presence. */
  announceLeave(client: ConnectedClient, channel: string, entry: PresenceEntry): void
}

/**
 * Keeps what a socket holds in step with what it is allowed to hold.
 *
 * A grant is decided at join and then only read, which is what keeps broadcast cheap. So whatever
 * can make a grant wrong has to prompt a new decision, and this is where those prompts land: a new
 * token, a schema push, a change to a table a rule reads, and a timer behind all of them. Each one
 * judges the held channels again as the socket's current claims and applies the answer: a channel
 * the user is no longer admitted to is removed with a presence leave, and a right that was taken
 * back (to send or to track) takes effect on the next frame.
 */
export class ChannelEnforcer {
  private readonly rechecker: ChannelRechecker

  constructor(
    private readonly channels: ChannelManager,
    private readonly guard: ChannelGuard,
    private readonly catalog: ChannelCatalog,
    private readonly hooks: EnforcementHooks,
    private readonly log: (message: string) => void,
    intervalSeconds: number,
  ) {
    this.rechecker = new ChannelRechecker({
      intervalMs: intervalSeconds * 1000,
      debounceMs: DEBOUNCE_MS,
      run: (scope) => this.recheckAll(scope),
      onError: (err) => this.log(`channel re-check failed (SQLSTATE ${sqlState(err)})`),
    })
  }

  start(): void {
    this.rechecker.start()
    // Read the catalog before the first join needs it, so the first join does not pay for it.
    this.catalog.current().catch(() => {})
  }

  stop(): void {
    this.rechecker.stop()
  }

  /** How many re-check runs have begun: a join compares it before and after it is decided. */
  get epoch(): number {
    return this.rechecker.epoch
  }

  /** A schema push may have changed the rules themselves, so every held channel is judged against the new ones. */
  async afterSchemaPush(): Promise<void> {
    await this.catalog.reload()
    await this.rechecker.runNow({ kind: "all" })
  }

  /** A change to a table some declaration's rules read means who is admitted may have changed. */
  noteChange(change: WalChange): void {
    const declarations = this.guard.declarationsReading(tableKey(change.schema, change.table))
    if (declarations !== undefined) this.rechecker.markDirty(declarations)
  }

  /** Take a client out of a channel: its subscription, and the presence it held there, announced. */
  dropMembership(clientId: string, client: ConnectedClient, channel: string): void {
    const entry = this.channels.unsubscribe(clientId, channel)
    if (entry) this.hooks.announceLeave(client, channel, entry)
  }

  /** Remove a client from a channel and tell it why. */
  withdraw(clientId: string, client: ConnectedClient, channel: string, message: string): void {
    this.dropMembership(clientId, client, channel)
    this.hooks.refuse(client, channel, message)
  }

  /**
   * Judge a client's channels in `scope` again as its current claims, and apply the answer.
   *
   * `failClosed` is for the moments an identity just changed (a new token): if the database cannot
   * answer, the channels are withdrawn, because keeping them would keep what the *old* identity was
   * allowed. For a sweep with no such cause an unanswered question changes nothing and is asked
   * again next time: it did not grant anything, and a blip must not empty every channel.
   */
  async recheckClient(clientId: string, client: ConnectedClient, scope: RecheckScope, failClosed: boolean): Promise<void> {
    const claims = client.claims
    const subs = [...client.subscriptions.values()].filter((sub) => inScope(scope, sub))
    if (subs.length === 0) return
    const before = new Map<string, ChannelGrant | undefined>(subs.map((sub) => [sub.channel, sub.access]))
    let outcomes: RecheckOutcome[]
    try {
      outcomes = await this.guard.recheck(claims, subs)
    } catch (err) {
      this.log(`could not re-check channel access (SQLSTATE ${sqlState(err)})`)
      // Only if the claims are still the ones asked about: a newer token has its own re-check coming.
      if (failClosed && client.claims === claims) this.withdrawAll(clientId, client, subs)
      return
    }
    // A token that arrived while the database was answering has made this answer about someone else.
    if (client.claims !== claims) return
    for (const outcome of outcomes) this.apply(clientId, client, outcome, before)
  }

  private withdrawAll(clientId: string, client: ConnectedClient, subs: readonly Subscription[]): void {
    for (const sub of subs) this.withdraw(clientId, client, sub.channel, refusals.unreachable(sub.channel))
  }

  private apply(
    clientId: string,
    client: ConnectedClient,
    outcome: RecheckOutcome,
    before: ReadonlyMap<string, ChannelGrant | undefined>,
  ): void {
    const held = client.subscriptions.get(outcome.channel)
    // A rejoin replaced the subscription while the question was out; its grant is newer than this answer.
    if (held === undefined || held.access !== before.get(outcome.channel)) return
    if ("withdrawn" in outcome) {
      this.withdraw(clientId, client, outcome.channel, outcome.withdrawn)
      return
    }
    this.channels.setAccess(clientId, outcome.channel, outcome.grant)
    if (outcome.grant.track !== null) this.takeBackPresence(clientId, client, outcome.channel)
  }

  /** A member who may no longer track presence stops appearing in it, and the others are told. */
  private takeBackPresence(clientId: string, client: ConnectedClient, channel: string): void {
    const entry = this.channels.untrackPresence(clientId, channel)
    if (entry) this.hooks.announceLeave(client, channel, entry)
  }

  private async recheckAll(scope: RecheckScope): Promise<void> {
    const queue = [...this.channels.entries()]
    const worker = async (): Promise<void> => {
      for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        const [clientId, client] = next
        await this.recheckClient(clientId, client, scope, false).catch((err: unknown) => {
          this.log(`channel re-check failed (SQLSTATE ${sqlState(err)})`)
        })
      }
    }
    await Promise.all(Array.from({ length: RECHECK_CONCURRENCY }, worker))
  }
}
