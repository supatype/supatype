import type {
  Int, LoggedIn, Model, Optional, Owner, PrimaryKey, RelatedTo, Role, SupatypeAuthUserId, UUID,
} from "@supatype/types"

/**
 * The masking matrix: field masking and row visibility on every channel a client reads through.
 *
 * Ported from the Phase 0 scripts (T1 for tier 1, T2 for tier 2). Every signed-in user sees every
 * employee row; `salary` is the admin's to read and write, `ssn` its owner's to read. `grade` is
 * deliberately unmasked and numeric, so a realtime filter on it shows how values are compared.
 */
export type Employee = Model<{
  id: SupatypeAuthUserId
  name: string
  grade: Int
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

/**
 * A primary key not named `id`, behind a first column that is not unique: realtime once keyed rows
 * by the first column (M06). `amount` is the admin's; `bank_account` belongs to the employee.
 */
export type Payslip = Model<{
  dept: string
  ref: PrimaryKey<UUID>
  employee: RelatedTo<Employee, { required: true; onDelete: "cascade" }>
  amount: Optional<Int>
  bank_account: Optional<string>
}, {
  access: {
    read: LoggedIn
    create: Role<"admin">
    update: Role<"admin">
    delete: Role<"admin">
    fields: {
      amount: { read: Role<"admin"> }
      bank_account: { read: Owner<"employee_id"> }
    }
  }
}>

/** Visible to its owner only: nobody else may learn of an insert, an update or a delete (P03). */
export type Note = Model<{
  id: SupatypeAuthUserId
  body: string
}, {
  access: {
    read: Owner<"id">
    create: Owner<"id">
    update: Owner<"id">
    delete: Owner<"id">
  }
}>

/** Owner-only rows whose key is `code` and whose first column is a shared `category` (M06). */
export type Ticket = Model<{
  category: string
  code: PrimaryKey<UUID>
  owner: RelatedTo<Employee, { required: true; onDelete: "cascade" }>
  label: string
}, {
  access: {
    read: Owner<"owner_id">
    create: Role<"service_role">
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>
