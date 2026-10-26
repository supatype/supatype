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

/**
 * Two field rules whose predicate names are the same once cut to Postgres's 63-byte identifier
 * limit, so the engine gives one of them a number (`..._1`). Which column gets the number is the
 * engine's choice, so realtime has to be told rather than rebuild it. `..._alpha`: the row's owner
 * only; `..._beta`: admin only, so a swapped mapping shows as the wrong column delivered.
 */
export type Appraisal = Model<{
  id: SupatypeAuthUserId
  manager_review_notes_for_the_quarterly_appraisal_alpha: Optional<string>
  manager_review_notes_for_the_quarterly_appraisal_beta: Optional<string>
}, {
  access: {
    read: LoggedIn
    create: Owner<"id">
    update: Owner<"id">
    delete: Owner<"id">
    fields: {
      manager_review_notes_for_the_quarterly_appraisal_alpha: { read: Owner<"id"> }
      manager_review_notes_for_the_quarterly_appraisal_beta: { read: Role<"admin"> }
    }
  }
}>
