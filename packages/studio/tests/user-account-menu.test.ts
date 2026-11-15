import { describe, expect, it } from "vitest"
import { accountUrl } from "../src/components/UserAccountMenu.js"

describe("the account menu's link to Cloud", () => {
  it("goes to the account pages, which Cloud serves under /account, not the /dashboard that has no page", () => {
    expect(accountUrl("https://cloud.supatype.com")).toBe("https://cloud.supatype.com/account")
  })

  it("does not double the slash when the Cloud URL ends with one", () => {
    expect(accountUrl("https://cloud.supatype.com/")).toBe("https://cloud.supatype.com/account")
  })
})
