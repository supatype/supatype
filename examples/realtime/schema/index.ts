import type { Model, Public, Timestamp, UUID } from "@supatype/types"

/**
 * A message on a shared board.
 *
 * Everything here is public on purpose: the point of the example is what a
 * subscriber receives when a row changes, and an access rule that hid the row
 * would make the absence of an event ambiguous. Access control has its own
 * examples; this one is about delivery.
 */
export type Message = Model<{
  id: UUID
  body: string
  author: string
  created_at: Timestamp
}, {
  access: {
    read: Public
    create: Public
    update: Public
    delete: Public
  }
}>
