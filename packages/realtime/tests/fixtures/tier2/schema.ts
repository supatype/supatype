import type {
  Int, LoggedIn, Model, Optional, Owner, OwnerFrom, PrimaryKey, RelatedTo, Role,
  SupatypeAuthUser, SupatypeAuthUserId, UUID,
} from "@supatype/types"

/** Tier-2 realtime fixture. name: any signed-in user; salary: admin only; ssn: the row's owner only. */
export type Employee = Model<{
  id: SupatypeAuthUserId
  name: string
  salary: Optional<Int>
  ssn: Optional<string>
}, {
  access: {
    read: LoggedIn
    create: Owner<"id">
    update: Owner<"id">
    delete: Owner<"id">
    fields: {
      name: { read: LoggedIn }
      salary: { read: Role<"admin">, write: Role<"admin"> }
      ssn: { read: Owner<"id"> }
    }
  }
}>

/** Primary key not named id; amount readable only by the payslip's owner. */
export type Payslip = Model<{
  ref: PrimaryKey<UUID>
  owner: RelatedTo<SupatypeAuthUser>
  month: string
  amount: Optional<Int>
}, {
  access: {
    read: LoggedIn
    create: Role<"admin">
    update: Role<"admin">
    delete: Role<"admin">
    fields: { amount: { read: OwnerFrom<"owner"> } }
  }
}>
