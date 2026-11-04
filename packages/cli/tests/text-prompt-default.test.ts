import { describe, expect, it } from "vitest"
import { textPromptAnswer, textPromptHints } from "../src/ui/flows/prompt-fields.js"

/**
 * Fresh-user test C10: init's gateway port prompt put the default in the input as editable text,
 * so typing a port appended to it (`18478` + `8700` = `184788700`) and the answer was refused.
 * The input starts empty, and a default is used when the answer is left empty.
 *
 * Fresh-user test, later: with the default shown as the input's placeholder, a real default (the
 * Kong port, 18478) looked exactly like an example meaning "empty" (the domain, api.example.com).
 * A default is now named beside the question, and an example is shown in the input as `e.g. ...`.
 */
const port = { kind: "text" as const, message: "Local API gateway port (Kong)", defaultValue: "18478" }
const domain = { kind: "text" as const, message: "Production domain", placeholder: "api.example.com", defaultValue: "" }

describe("text prompt default", () => {
  it("names a real default beside the question, with no example in the input", () => {
    expect(textPromptHints(port)).toEqual({ defaultHint: "(default 18478)" })
  })

  it("shows a placeholder as an example, not as a default", () => {
    expect(textPromptHints(domain)).toEqual({ example: "e.g. api.example.com" })
  })

  it("does not show an example beside a real default, since Enter gives the default", () => {
    expect(textPromptHints({ ...port, placeholder: "18473" })).toEqual({ defaultHint: "(default 18478)" })
  })

  it("uses the default when the answer is left empty", () => {
    expect(textPromptAnswer("", port)).toBe("18478")
    expect(textPromptAnswer("   ", port)).toBe("18478")
  })

  it("uses what was typed in place of the default", () => {
    expect(textPromptAnswer("18700", port)).toBe("18700")
  })

  it("answers empty when there is no default, whatever the example", () => {
    expect(textPromptHints({ kind: "text", message: "Admin email" })).toEqual({})
    expect(textPromptAnswer("", { kind: "text", message: "Admin email", placeholder: "you@example.com" })).toBe("")
    expect(textPromptAnswer("", domain)).toBe("")
  })
})
