import { supatype } from "./supatype"
import type { MenuItem, Reward } from "./catalog"
import type { SerializedEditorState } from "@supatype/types/lexical"

// Column names match the Supatype schema (RelatedTo<> becomes <field>_id).
// bio is a RichText column → stored as a Lexical document (jsonb).
export type RichTextDoc = SerializedEditorState

export interface Customer {
  id: string
  name: string
  bio: RichTextDoc | null
  stars: number
  lifetimeStars: number
  created_at: string
  updated_at: string
}

export interface Activity {
  id: string
  auth_user_id: string
  customer_id: string
  kind: "earn" | "redeem"
  label: string
  emoji: string
  stars: number
  amount: number | null
  created_at: string
}

export async function fetchCustomer(uid: string): Promise<Customer | null> {
  const { data } = await supatype.from("customer").select("*").eq("id", uid).limit(1)
  return (data?.[0] as Customer | undefined) ?? null
}

/** Get-or-create the loyalty profile for a freshly signed-in user. */
export async function ensureCustomer(uid: string, name: string): Promise<Customer> {
  const existing = await fetchCustomer(uid)
  if (existing) return existing
  const { data, error } = await supatype
    .from("customer")
    .insert({ id: uid, name, stars: 0, lifetimeStars: 0 })
  if (error) throw new Error(error.message)
  return (data as Customer[])[0]!
}

export async function fetchActivity(uid: string): Promise<Activity[]> {
  const { data } = await supatype
    .from("activity")
    .select("*")
    .eq("auth_user_id", uid)
    .order("created_at", { ascending: false })
    .limit(50)
  return (data as Activity[] | null) ?? []
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
  return (data as Customer[])[0]!
}

/** Update the customer's profile (name and bio). bio is a RichText (jsonb) column;
 *  for this demo we store a plain string, which is valid JSON. */
export async function updateProfile(
  uid: string,
  fields: { name?: string; bio?: RichTextDoc | null },
): Promise<Customer> {
  const { data, error } = await supatype.from("customer").update(fields).eq("id", uid)
  if (error) throw new Error(error.message)
  return (data as Customer[])[0]!
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
  return (data as Customer[])[0]!
}
