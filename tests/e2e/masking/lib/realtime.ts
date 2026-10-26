import { createClient, type RealtimePayload } from "@supatype/client"
import { stack } from "./stack.js"
import { world, type Person } from "./world.js"

export type Row = Record<string, unknown>
export type Event = RealtimePayload<Row>

export interface Feed {
  events: Event[]
  ready: boolean
  unsubscribe: () => void
}

type Client = ReturnType<typeof createClient>

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function signedInClient(person: Person): Promise<Client> {
  const client = createClient({ url: stack().baseUrl, anonKey: stack().anonKey })
  const { email, password } = world()[person]
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`realtime sign in ${person}: ${error.message}`)
  return client
}

/** Subscribes to every change on a table (optionally filtered) and waits for the join. */
export async function feed(client: Client, table: string, filter?: string): Promise<Feed> {
  const events: Event[] = []
  const sub = client.from(table).subscribe((p) => events.push(p as Event), {
    event: "*",
    ...(filter !== undefined && { filter }),
  })
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000)
    sub.channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer)
        resolve(true)
      }
    })
  })
  return { events, ready, unsubscribe: sub.unsubscribe }
}

/** Polls until an event matches, up to a deadline; false when it never came. */
export async function waitFor(events: Event[], match: (e: Event) => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (events.some(match)) return true
    await sleep(200)
  }
  return false
}

/** The row an event is about: the new image, or the old one for a DELETE. */
export const rowOf = (e: Event): Row => e.new ?? e.old ?? {}
