import { describe, expect, it } from "vitest"
import { FUNCTION_SECRET_NAME_PATTERN, functionSecretNameProblem, isFunctionSecretName } from "../src/index.js"

describe("function secret names", () => {
  it.each(["API_KEY", "_private", "a", "Stripe2", "__x__"])("accepts %s", (name) => {
    expect(isFunctionSecretName(name)).toBe(true)
    expect(functionSecretNameProblem(name)).toBeUndefined()
    expect(FUNCTION_SECRET_NAME_PATTERN.test(name)).toBe(true)
  })

  it.each(["", "1KEY", "MY-KEY", "MY KEY", "a.b", "naïve", "KEY\n"])("refuses %j with a message that names it", (name) => {
    expect(isFunctionSecretName(name)).toBe(false)
    expect(functionSecretNameProblem(name)).toBe(
      `"${name}" is not a valid secret name: use letters, digits and underscore, and do not start with a digit.`,
    )
  })
})
