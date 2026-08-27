import { fieldValidator, type FieldValidator } from "../_supatype/hooks.ts"

/**
 * Total setup time across the items, capped.
 *
 * Deliberately a rule the other two mechanisms cannot express. `MinItems` bounds how many there are
 * and a constraint could bound that too, but neither can sum a number out of each element of a JSON
 * array and compare the total: that needs code.
 *
 * The message is what the author will read on the input, so it says what is wrong and by how much
 * rather than restating the rule.
 */
const MAX_TOTAL_MINUTES = 120

const validateSetupItems: FieldValidator<"product", "setupItems"> = (ctx) => {
  const items = ctx.value
  if (!Array.isArray(items)) return true

  let total = 0
  for (const item of items) {
    const minutes = (item as { minutes?: unknown }).minutes
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
      return "Every setup item needs a positive number of minutes."
    }
    total += minutes
  }

  if (total > MAX_TOTAL_MINUTES) {
    return `Setup takes ${total} minutes in total, which is ${total - MAX_TOTAL_MINUTES} over the ${MAX_TOTAL_MINUTES} minute limit.`
  }
  return true
}

export default fieldValidator(validateSetupItems)
