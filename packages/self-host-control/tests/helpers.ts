import { strict as assert } from "node:assert"
import { isJsonObject, isString } from "@supatype/shared"
import { createControlPlaneServer } from "../src/server.js"
import { CONTROL_PLANE_SECRET_HEADER } from "../src/auth.js"

/** The secret every test server is started with, and every test request presents by default. */
export const TEST_SECRET = "control-plane-test-secret-0123456789abcdef"

export type ControlPlaneServer = ReturnType<typeof createControlPlaneServer>

/** Start a control plane on a free loopback port, holding `secret`. */
export async function startServer(
  secret = TEST_SECRET,
): Promise<{ server: ControlPlaneServer; baseUrl: string }> {
  const server = createControlPlaneServer(secret)
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

/**
 * One JSON request to the control plane.
 *
 * Presents {@link TEST_SECRET} unless told otherwise: `secret: null` sends no header at all.
 */
export async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  secret: string | null = TEST_SECRET,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(secret !== null && { [CONTROL_PLANE_SECRET_HEADER]: secret }),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: jsonObject(text === "" ? {} : JSON.parse(text)) }
}

/** `value` as an object, failing the test when it is not one. */
export function jsonObject(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) assert.fail(`expected a JSON object, got ${JSON.stringify(value)}`)
  return value
}

/** A response body's `data`, failing the test when it is not an object. */
export function dataOf(json: Record<string, unknown>): Record<string, unknown> {
  return jsonObject(json["data"])
}

/** The string at `data[key]`, failing the test when it is not one. */
export function dataString(json: Record<string, unknown>, key: string): string {
  const value = dataOf(json)[key]
  if (typeof value !== "string") assert.fail(`expected a string at data.${key}, got ${JSON.stringify(value)}`)
  return value
}

/** The list of strings at `data[key]`, failing the test when it is not one. */
export function dataStrings(json: Record<string, unknown>, key: string): string[] {
  const value = dataOf(json)[key]
  if (!Array.isArray(value) || !value.every(isString)) assert.fail(`expected strings at data.${key}, got ${JSON.stringify(value)}`)
  return value
}
