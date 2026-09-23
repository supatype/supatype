import type {
  LoggedIn,
  MaxLength,
  Model,
  Optional,
  OwnerFrom,
  RelatedTo,
  SupatypeAuthUser,
  Timestamp,
  UUID,
} from "@supatype/types"

/**
 * One model, because the example is about the bindings rather than the schema.
 *
 * Everything the three apps do happens against this: list it, add to it, watch someone else add to
 * it, and check who may change it. A second model would make the apps longer without making the
 * comparison any clearer.
 */
export type Task = Model<{
  id: UUID
  title: MaxLength<string, 200>
  done: boolean
  authUser: RelatedTo<SupatypeAuthUser>
  note: Optional<string>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    // Everyone signed in sees the list, so two browsers can watch each other's inserts arrive.
    read: LoggedIn
    create: LoggedIn
    // Yours to change, nobody else's — the same rule in all three apps, enforced in neither.
    update: OwnerFrom<"authUser">
    delete: OwnerFrom<"authUser">
  }
}>
