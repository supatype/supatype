/**
 * Rotating the SAML service provider's signing key, in the project's `.env`.
 *
 * Two steps with an overlap between them. `createNextSamlKey` writes a second key; the server then
 * publishes both certificates in its SP metadata, still signs with the current key, and decrypts
 * with either, while each identity provider takes the new certificate. `promoteNextSamlKey` makes
 * the next key the current one and removes it as the next.
 */
import { hasEnvValue, readEnvValue, upsertEnvFile } from "./env-file.js"
import { generateSamlPrivateKey, SAML_NEXT_PRIVATE_KEY_ENV, SAML_PRIVATE_KEY_ENV } from "./saml-config.js"

/** Write a next key into `.env` unless one is there already, which is kept. The value is never printed. */
export function createNextSamlKey(cwd: string): "created" | "exists" {
  if (hasEnvValue(cwd, SAML_NEXT_PRIVATE_KEY_ENV)) return "exists"
  upsertEnvFile(cwd, { [SAML_NEXT_PRIVATE_KEY_ENV]: generateSamlPrivateKey() })
  return "created"
}

/** Make the next key the current one, in place, and remove the next. */
export function promoteNextSamlKey(cwd: string): "promoted" | "no-next-key" {
  const next = readEnvValue(cwd, SAML_NEXT_PRIVATE_KEY_ENV, "")
  if (next === "") return "no-next-key"
  upsertEnvFile(cwd, { [SAML_PRIVATE_KEY_ENV]: next }, { remove: [SAML_NEXT_PRIVATE_KEY_ENV] })
  return "promoted"
}
