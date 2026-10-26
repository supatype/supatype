import { supatype } from "./supatype"
import type { TableRow } from "../supatype/generated/client"
import type { MenuItem, Reward } from "./catalog"
import type { SerializedEditorState } from "@supatype/types/lexical"

// Row types come from the generated client, so they follow the schema (RelatedTo<> becomes
// <field>_id). bio is a RichText column, stored as a Lexical document (jsonb).
export type RichTextDoc = SerializedEditorState
export type Customer = TableRow<"customer">
export type Activity = TableRow<"activity">

/** The row a write handed back. One that matched nothing (wrong id, or RLS refused it) is an error. */
function writtenRow<T>(data: T[] | null): T {
  const row = data?.[0]
  if (row === undefined) throw new Error("The write returned no row")
  return row
}

export async function fetchCustomer(uid: string): Promise<Customer | null> {
  const { data } = await supatype.from("customer").select("*").eq("id", uid).limit(1)
  return data?.[0] ?? null
}

/** Get-or-create the loyalty profile for a freshly signed-in user. */
export async function ensureCustomer(uid: string, name: string): Promise<Customer> {
  const existing = await fetchCustomer(uid)
  if (existing) return existing
  const { data, error } = await supatype
    .from("customer")
    .insert({ id: uid, name, stars: 0, lifetimeStars: 0 })
  if (error) throw new Error(error.message)
  return writtenRow(data)
}

export async function fetchActivity(uid: string): Promise<Activity[]> {
  const { data } = await supatype
    .from("activity")
    .select("*")
    .eq("auth_user_id", uid)
    .order("created_at", { ascending: false })
    .limit(50)
  return data ?? []
}

/** Simulate paying for a drink: log the activity and credit the stars. */
export async function earnStars(customer: Customer, item: MenuItem): Promise<Customer> {
  await supatype.from("activity").insert({
    auth_user_id: customer.id,
    customer_id: customer.id,
    kind: "earn",
    label: item.label,
    emoji: item.emoji,
    stars: item.stars,
    amount: item.amount,
  })
  const { data, error } = await supatype
    .from("customer")
    .update({
      stars: customer.stars + item.stars,
      lifetimeStars: customer.lifetimeStars + item.stars,
    })
    .eq("id", customer.id)
  if (error) throw new Error(error.message)
  return writtenRow(data)
}

/** Update the customer's profile (name and bio). bio is a RichText (jsonb) column;
 *  for this demo we store a plain string, which is valid JSON. */
export async function updateProfile(
  uid: string,
  fields: { name?: string; bio?: RichTextDoc | null },
): Promise<Customer> {
  const { data, error } = await supatype.from("customer").update(fields).eq("id", uid)
  if (error) throw new Error(error.message)
  return writtenRow(data)
}

/** Redeem a reward: log it and debit the stars. */
export async function redeemReward(customer: Customer, reward: Reward): Promise<Customer> {
  await supatype.from("activity").insert({
    auth_user_id: customer.id,
    customer_id: customer.id,
    kind: "redeem",
    label: reward.name,
    emoji: reward.emoji,
    stars: -reward.cost,
    amount: null,
  })
  const { data, error } = await supatype
    .from("customer")
    .update({ stars: customer.stars - reward.cost })
    .eq("id", customer.id)
  if (error) throw new Error(error.message)
  return writtenRow(data)
}
