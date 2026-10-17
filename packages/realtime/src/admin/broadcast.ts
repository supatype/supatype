import type { IncomingMessage, ServerResponse } from "node:http"
import { AdminError, readBodyLimited, sendData } from "./http.js"
import { actorOf } from "./auth.js"
import { isJsonObject } from "../json.js"

/**
 * `POST /admin/v1/broadcast`: the Studio broadcast tester.
 *
 * Validated, sized and rate limited here rather than in either control plane, so one implementation
 * covers self-host and Cloud and the limit holds however many control-plane replicas there are.
 */

export const CHANNEL_MAX = 255
export const EVENT_MAX = 255
/** The serialised payload limit, a constant until the broadcast payload-limit setting lands. */
export const PAYLOAD_LIMIT_BYTES = 256 * 1024
/** What the body may be before it is refused unread: the payload limit and room for the envelope. */
const BODY_LIMIT_BYTES = PAYLOAD_LIMIT_BYTES + 16 * 1024
export const PER_ACTOR_PER_MINUTE = 10
export const PER_INSTANCE_PER_MINUTE = 60

export interface BroadcastInput {
  channel: string
  event: string
  payload: Record<string, unknown>
}

/** A token bucket holding `perMinute` tokens, refilled continuously. */
class Bucket {
  private tokens: number
  private at = Date.now()

  constructor(private readonly perMinute: number) {
    this.tokens = perMinute
  }

  private refill(): void {
    const now = Date.now()
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.at) / 60_000) * this.perMinute)
    this.at = now
  }

  /** Seconds until a token is free, or 0 when one is available now. */
  wait(): number {
    this.refill()
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * 60) / this.perMinute)
  }

  take(): void {
    this.tokens -= 1
  }

  get full(): boolean {
    this.refill()
    return this.tokens >= this.perMinute
  }
}

/** Ten a minute per Studio user, sixty a minute for the instance. */
export class BroadcastLimiter {
  private readonly instance = new Bucket(PER_INSTANCE_PER_MINUTE)
  private readonly actors = new Map<string, Bucket>()

  /** Take a token for `actor`, or throw 429 with the seconds to wait. */
  take(actor: string): void {
    const bucket = this.actors.get(actor) ?? new Bucket(PER_ACTOR_PER_MINUTE)
    this.actors.set(actor, bucket)
    const wait = Math.max(bucket.wait(), this.instance.wait())
    if (wait > 0) {
      throw new AdminError(429, "rate_limited", `Too many test broadcasts; retry in ${wait} s`, {
        "Retry-After": String(wait),
      })
    }
    bucket.take()
    this.instance.take()
    this.forgetIdle()
  }

  /** Drop buckets that have refilled, so the map holds only actors who broadcast recently. */
  private forgetIdle(): void {
    if (this.actors.size < 100) return
    for (const [actor, bucket] of this.actors) if (bucket.full) this.actors.delete(actor)
  }
}

function nameField(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new AdminError(400, "validation_error", `${field} must be a non-empty string of at most ${max} characters`)
  }
  return value
}

/** The request, validated: names bounded, payload a JSON object within the size limit. */
export function parseBroadcast(body: string): BroadcastInput {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AdminError(400, "validation_error", "The body must be JSON")
  }
  const input = isJsonObject(parsed) ? parsed : {}
  const channel = nameField(input["channel"], "channel", CHANNEL_MAX)
  const event = nameField(input["event"], "event", EVENT_MAX)
  const payload = input["payload"]
  if (!isJsonObject(payload)) {
    throw new AdminError(400, "validation_error", "payload must be a JSON object")
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_LIMIT_BYTES) {
    throw new AdminError(413, "payload_too_large", `payload is over ${PAYLOAD_LIMIT_BYTES / 1024} KB`)
  }
  return { channel, event, payload }
}

/** Answer one broadcast request; `send` fans it out and returns how many it reached. */
export async function handleBroadcast(
  req: IncomingMessage,
  res: ServerResponse,
  limiter: BroadcastLimiter,
  send: (input: BroadcastInput) => number,
): Promise<void> {
  const input = parseBroadcast(await readBodyLimited(req, BODY_LIMIT_BYTES))
  limiter.take(actorOf(req))
  sendData(res, { recipients: send(input) })
}
