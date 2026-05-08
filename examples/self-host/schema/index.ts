import type { Model, Public, Owner, SupatypeAuthUserId, UUID } from "@supatype/types"

export type Todo = Model<{
  id: SupatypeAuthUserId
  title: string
  done: boolean
  owner_id: UUID
  created_at: string
}, {
  access: {
    read: Public
    create: Public
    update: Owner<"id">
    delete: Owner<"id">
  }
}>
