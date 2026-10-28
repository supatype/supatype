/**
 * Database passwords the compose file puts into connection URLs unencoded.
 *
 * The compose template builds DSNs as `postgresql://role:${VAR}@db:5432/...`, and compose fills the
 * variable in at up-time, after anything the CLI could encode. A password holding `@`, `:`, `/` or
 * `#` then yields a URL naming a different host, port or database, and the stack fails far from the
 * cause. Refusing such a value before compose runs is the only place the CLI can say why.
 */

import { readEnvFile } from "./env-file.js"
import { usesExternalDatabase, type SupatypeProjectConfig } from "./project-config.js"
import { SQL_EDITOR_PASSWORD_ENV } from "./local-secrets.js"
import { fatalError } from "./ui/fatal.js"
import { warn } from "./ui/messages.js"

/**
 * What may appear unencoded in a URL's userinfo: RFC 3986's unreserved and sub-delims. Anything
 * else is syntax (`@ : / ? # [ ]`), an escape (`%`), or not valid in a URL at all.
 */
const URL_SAFE = /^[A-Za-z0-9\-._~!$&'()*+,;=]*$/

/** The first character of `value` a URL's userinfo cannot hold unencoded, or undefined. */
function firstUnsafeChar(value: string): string | undefined {
  return [...value].find((char) => !URL_SAFE.test(char))
}

/**
 * One line per password in `env` the compose file would put into a URL it breaks.
 *
 * `POSTGRES_PASSWORD` only for the bundled database: with an external one the owner's URL is the
 * operator's own `DATABASE_URL`, which they encode.
 */
export function composePasswordProblems(env: Record<string, string>, external: boolean): string[] {
  const vars = [
    ...(external ? [] : ["POSTGRES_PASSWORD"]),
    "AUTHENTICATOR_PASSWORD",
    SQL_EDITOR_PASSWORD_ENV,
  ]
  return vars.flatMap((name) => {
    const char = firstUnsafeChar(env[name] ?? "")
    return char === undefined ? [] : [`${name} in .env contains ${JSON.stringify(char)}`]
  })
}

/** What is wrong with `cwd`'s compose passwords, as one sentence, or undefined when nothing is. */
function composePasswordProblem(cwd: string, config: SupatypeProjectConfig): string | undefined {
  const problems = composePasswordProblems(readEnvFile(cwd), usesExternalDatabase(config))
  if (problems.length === 0) return undefined
  return `${problems.join("; ")}, which breaks the database URL the compose file builds from it.`
}

const URL_SAFE_PASSWORD_REMEDY = [
  "Use only letters, digits and - . _ ~ in these passwords. To generate one: openssl rand -hex 24",
  "If the database already exists, also set the role's new password in it (ALTER ROLE ... PASSWORD).",
]

/** Stop before compose runs when a password in `.env` would break the URLs it is used in. */
export function requireUrlSafeComposePasswords(cwd: string, config: SupatypeProjectConfig): void {
  const problem = composePasswordProblem(cwd, config)
  if (problem !== undefined) fatalError(problem, URL_SAFE_PASSWORD_REMEDY)
}

/**
 * Say so, without stopping, when a password in `.env` would break the URLs it is used in. For the
 * commands that start only the database on the way to something else (push, diff, dev's recovery),
 * which are not stopped over a database that starts either way.
 */
export function warnUrlUnsafeComposePasswords(cwd: string, config: SupatypeProjectConfig): void {
  const problem = composePasswordProblem(cwd, config)
  if (problem === undefined) return
  warn(problem)
  for (const hint of URL_SAFE_PASSWORD_REMEDY) warn(hint)
}
