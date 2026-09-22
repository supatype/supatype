import { fieldValidator, type FieldValidator } from "../_supatype/hooks.ts"

/**
 * A lobby message that reads like a message.
 *
 * The bound above says how long it may be and the constraint says it cannot be a single character.
 * Neither can say "this is shouting", because both measure the value rather than look at it —
 * which is the whole reason this third mechanism exists.
 *
 * The message is what the sender reads on the input, so it says what to change.
 */
const validateChatBody: FieldValidator<"chat_message", "body"> = (ctx) => {
  const body = typeof ctx.value === "string" ? ctx.value : ""

  const letters = body.replace(/[^\p{L}]/gu, "")
  if (letters.length >= 6 && letters === letters.toUpperCase()) {
    return "That reads as shouting. Try it in lower case."
  }

  return true
}

export default fieldValidator(validateChatBody)
