import type {
  Model,
  UUID,
  Int,
  Timestamp,
  Optional,
  RichText,
  RelatedTo,
  Owner,
  OwnerFrom,
  LoggedIn,
  SupatypeAuthUser,
  SupatypeAuthUserId,
} from "@supatype/types"

/**
 * Customer — the loyalty profile, one row per signed-in user.
 *
 * `id` is the Supatype auth user id, so each person owns exactly their own
 * profile (RLS Owner). `stars` is the spendable balance; `lifetimeStars` only
 * ever grows and drives the Green/Gold tier in the UI.
 */
export type Customer = Model<{
  id: SupatypeAuthUserId
  name: string
  bio: Optional<RichText>
  stars: Int
  lifetimeStars: Int
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: Owner<"id">
    create: LoggedIn
    update: Owner<"id">
    delete: Owner<"id">
  }
}>

/**
 * Activity — one row per star event (earning a coffee or redeeming a reward).
 *
 * `kind` distinguishes earn vs redeem; `stars` is the signed delta (positive
 * when earning, negative when redeeming). Drives the activity feed on the
 * profile screen. Owned by the user who created it.
 */
export type Activity = Model<{
  id: UUID
  authUser: RelatedTo<SupatypeAuthUser>
  customer: RelatedTo<Customer>
  kind: "earn" | "redeem"
  label: string
  emoji: string
  stars: Int
  amount: Optional<Int>
  created_at: Timestamp
}, {
  access: {
    read: OwnerFrom<"authUser">
    create: LoggedIn
    update: OwnerFrom<"authUser">
    delete: OwnerFrom<"authUser">
  }
}>
