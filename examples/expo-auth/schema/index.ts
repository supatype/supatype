import type {
  LoggedIn,
  Model,
  Optional,
  Owner,
  OwnerFrom,
  RelatedTo,
  SupatypeAuthUser,
  SupatypeAuthUserId,
  Timestamp,
  UUID,
} from "@supatype/types"

/**
 * Minimal profile row for the signed-in Expo user.
 * Demonstrates schema → generated types → typed `createNativeClient`.
 */
export type Profile = Model<
  {
    id: SupatypeAuthUserId
    displayName: Optional<string>
    created_at: Timestamp
    updated_at: Timestamp
  },
  {
    access: {
      read: LoggedIn
      create: LoggedIn
      update: Owner<"id">
      delete: Owner<"id">
    }
  }
>

/** Shared lobby chat — realtime INSERT events on `chat_message`. */
export type ChatMessage = Model<
  {
    id: UUID
    room: string
    body: string
    authUser: RelatedTo<SupatypeAuthUser>
    authorName: Optional<string>
    created_at: Timestamp
  },
  {
    access: {
      read: LoggedIn
      create: LoggedIn
      update: OwnerFrom<"authUser">
      delete: OwnerFrom<"authUser">
    }
  }
>
