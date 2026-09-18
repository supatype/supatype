import { fieldValidator, type FieldValidator } from "../_supatype/hooks.ts"

/**
 * A title a conference programme can actually print.
 *
 * Deliberately a rule the other two mechanisms cannot express. `MaxLength` bounds how long it is
 * and a `CHECK` could bound that too; neither can say "this is shouting" or "this is three words of
 * clickbait", because both need to look at the shape of the text rather than its size.
 *
 * The refusal names the field, which is the whole difference from putting this in `hooks`: Studio
 * puts the message on the input rather than in a banner over the form.
 */
const validateTalkTitle: FieldValidator<"talk", "title"> = (ctx) => {
  const title = typeof ctx.value === "string" ? ctx.value.trim() : ""

  if (title === "") return "A talk needs a title."

  const letters = title.replace(/[^\p{L}]/gu, "")
  if (letters.length >= 8 && letters === letters.toUpperCase()) {
    return "Titles are printed as written, and this one is all capitals."
  }

  if (/[!?]{2,}|\.{3,}$/.test(title)) {
    return "Drop the trailing punctuation: the programme sets its own emphasis."
  }

  return true
}

export default fieldValidator(validateTalkTitle)
