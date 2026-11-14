import type {
  ManyToMany,
  Model,
  Owner,
  Public,
  RelatedTo,
  Role,
  SupatypeAuthUserId,
  Unique,
  UUID,
  LoggedIn,
} from "@supatype/types"

/** Keyed by the auth user id, so `Owner<"owner_id">` on a lot means that user. */
export type member = Model<{
  id: SupatypeAuthUserId
  name: string
}, {
  access: {
    read: Public
    create: LoggedIn
    update: Owner<"id">
    delete: Owner<"id">
  }
}>

export type lot = Model<{
  id: UUID
  title: string
  owner: RelatedTo<member, { required: true; onDelete: "cascade" }>
  tags: ManyToMany<tag>
  badges: ManyToMany<badge>
  shelves: ManyToMany<shelf>
}, {
  access: {
    read: Public
    create: LoggedIn
    update: Owner<"owner_id">
    delete: Owner<"owner_id">
  }
}>

export type tag = Model<{
  id: UUID
  name: Unique<string>
  lots: ManyToMany<lot>
}, {
  access: {
    read: Public
    create: LoggedIn
    // Nobody but the service role edits a tag. A link may be written by whoever can update either
    // end, so a tag any signed-in user could edit would let them link every lot.
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>

/**
 * Any signed-in user may edit a badge. Only `lot` declares the relation, so the link belongs to
 * `lot` and the right to edit a badge does not let anyone attach it to a lot.
 */
export type badge = Model<{
  id: UUID
  name: Unique<string>
}, {
  access: {
    read: Public
    create: LoggedIn
    update: LoggedIn
    delete: LoggedIn
  }
}>

/** A custom table name, to see what the junction is called when a model sets one. */
export type shelf = Model<{
  id: UUID
  name: string
  lots: ManyToMany<lot>
}, {
  tableName: "shelves"
  access: {
    read: Public
    create: LoggedIn
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>
