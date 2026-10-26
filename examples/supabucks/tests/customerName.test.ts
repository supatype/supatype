import { describe, expect, it } from "vitest"
import type { User } from "@supatype/client"
import { customerName } from "../src/customerName"

/**
 * The name a new customer is created with.
 *
 * An SSO sign-in carries the person's name from the provider (`full_name`, or `name`), and a
 * sign-up carries the one typed into the form (`name`). Naming everyone after their email's local
 * part, as this did, turned "Ada Lovelace" into "ada.l".
 */
function user(email: string, userMetadata: Record<string, unknown>): User {
  return { id: "u1", email, appMetadata: {}, userMetadata, createdAt: "", updatedAt: "" }
}

describe("customerName", () => {
  it("uses the provider's full name for an SSO user", () => {
    expect(customerName(user("ada.l@example.com", { full_name: "Ada Lovelace", name: "ada" }))).toBe("Ada Lovelace")
  })

  it("uses the provider's name when it gives no full name", () => {
    expect(customerName(user("grace@example.com", { name: " Grace Hopper " }))).toBe("Grace Hopper")
  })

  it("uses the name typed at sign-up", () => {
    expect(customerName(user("alan@example.com", { name: "Alan" }))).toBe("Alan")
  })

  it("falls back to the email's local part when nothing names the person", () => {
    expect(customerName(user("barista@example.com", { full_name: "  " }))).toBe("barista")
  })
})
