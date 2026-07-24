import type { Model, Public, UUID, Timestamp } from "@supatype/types"

/**
 * Note — written by the `write-note` edge function (service role)
 * and readable publicly so the UI can list recent rows after invoke.
 */
export type Note = Model<{
  id: UUID
  body: string
  created_at: Timestamp
}, {
  access: {
    read: Public
    create: Public
    update: Public
    delete: Public
  }
}>
