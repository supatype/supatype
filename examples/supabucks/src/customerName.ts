import type { User } from "@supatype/client"

/** Where a person's name can be: the provider's full name, then a plain name (provider or sign-up). */
const NAME_KEYS = ["full_name", "name"] as const

/**
 * The name a new customer is created with.
 *
 * An SSO sign-in carries the person's name from the provider and a sign-up carries the one typed
 * into the form, both in `userMetadata`; the email's local part is only the last resort.
 */
export function customerName(user: Pick<User, "email" | "userMetadata">): string {
  for (const key of NAME_KEYS) {
    const value = user.userMetadata[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return user.email?.split("@")[0] ?? "Member"
}
