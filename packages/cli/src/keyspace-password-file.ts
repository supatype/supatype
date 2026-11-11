/**
 * The keyspace password kept in a file (0.9.2 round 2, R2-S16).
 *
 * The Postgres image and the server both take SUPATYPE_KEYSPACE_PASSWORD_FILE, as
 * POSTGRES_PASSWORD_FILE works, and both refuse to start when it is set beside
 * SUPATYPE_KEYSPACE_PASSWORD. The CLI wrote a generated password into .env regardless, and in a
 * Docker stack the server reads .env too, so a project that named a file there got a server that
 * would not start. Named, the file is now the password's one source: the CLI writes no password,
 * mounts the file into the containers that read it, and refuses before compose runs what could not
 * start.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { readEnvFile } from "./env-file.js"
import { errorMessage } from "./error-message.js"
import { ensureKeyspacePassword, KEYSPACE_PASSWORD_ENV } from "./local-secrets.js"
import { fatalError, type FatalOptions } from "./ui/fatal.js"

/** The variable naming the file, as the image and the server read it. */
export const KEYSPACE_PASSWORD_FILE_ENV = `${KEYSPACE_PASSWORD_ENV}_FILE`

/** Where the db and server containers see the file: one fixed path, whatever the host's is. */
export const KEYSPACE_PASSWORD_CONTAINER_PATH = "/run/secrets/supatype-keyspace-password"

/** The file the project names for its keyspace password, and the password in it. */
export interface KeyspacePasswordFile {
  /** Absolute, on the host. */
  path: string
  password: string
}

/** Why a stack cannot start with the project's keyspace password, said the way fatalError says it. */
interface KeyspacePasswordProblem {
  ok: false
  problem: string
  hints: string[]
}

/** The file when the project names one, none when the password is in .env, or what is wrong. */
export type KeyspacePasswordSource = { ok: true; file: KeyspacePasswordFile | undefined } | KeyspacePasswordProblem

/** What the stack asks of the password: whether it uses one, and whether Kong needs it for HTTPS. */
export interface KeyspacePasswordUse {
  required: boolean
  tls: boolean
}

type Origin = "the shell" | ".env"

interface SetValue {
  value: string
  origin: Origin
}

/** `name`'s non-blank value and where it is set, the shell over .env as compose reads it. */
function setValue(name: string, dotenv: Record<string, string>, shell: NodeJS.ProcessEnv): SetValue | undefined {
  const fromShell = shell[name]
  const value = (fromShell ?? dotenv[name] ?? "").trim()
  if (value === "") return undefined
  return { value, origin: fromShell !== undefined ? "the shell" : ".env" }
}

/** The step that takes `name` away where it is set. */
function unsetStep(name: string, origin: Origin): string {
  return origin === ".env" ? `Remove the ${name} line from .env` : `Unset ${name} in the shell`
}

/** Both forms set, which the image and the server each refuse at start, or nothing. */
function bothSetProblem(dotenv: Record<string, string>, shell: NodeJS.ProcessEnv): KeyspacePasswordProblem | undefined {
  const password = setValue(KEYSPACE_PASSWORD_ENV, dotenv, shell)
  const file = setValue(KEYSPACE_PASSWORD_FILE_ENV, dotenv, shell)
  if (password === undefined || file === undefined) return undefined
  const where = password.origin === file.origin ? `both in ${file.origin}` : `the first in ${password.origin}, the second in ${file.origin}`
  return {
    ok: false,
    problem: `${KEYSPACE_PASSWORD_ENV} and ${KEYSPACE_PASSWORD_FILE_ENV} are both set (${where})`,
    hints: [
      "The keyspace takes its password one way, and the database and the server each refuse to start when given both.",
      `To use the file: ${unsetStep(KEYSPACE_PASSWORD_ENV, password.origin)}.`,
      `To keep the password: ${unsetStep(KEYSPACE_PASSWORD_FILE_ENV, file.origin)}.`,
    ],
  }
}

const TLS_PROBLEM: KeyspacePasswordProblem = {
  ok: false,
  problem: `${KEYSPACE_PASSWORD_FILE_ENV} cannot be used with HTTPS on (server.tls)`,
  hints: [
    "Kong keeps its certificates in the keyspace and logs in with the password through its env vault, " +
      "which reads environment variables only, never a file.",
    `Set ${KEYSPACE_PASSWORD_ENV} in .env instead of the file, or turn server.tls off and end HTTPS in front of the stack.`,
  ],
}

const FILE_HINTS = [
  "Write the keyspace password into it: one trailing newline is dropped, and nothing else.",
  `Or unset ${KEYSPACE_PASSWORD_FILE_ENV}, and the CLI generates ${KEYSPACE_PASSWORD_ENV} in .env.`,
]

/** One trailing CRLF or LF removed, as the image, the server and the extension read the file. */
function withoutOneNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2)
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

/** The password in `path`, or why the image and the server would refuse it. */
function readPasswordFile(path: string): KeyspacePasswordSource {
  const named = `${KEYSPACE_PASSWORD_FILE_ENV} names ${path}`
  const refused = (problem: string): KeyspacePasswordProblem => ({ ok: false, problem, hints: FILE_HINTS })
  if (!existsSync(path)) return refused(`${named}, which does not exist`)
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return refused(`${named}, which cannot be read (${errorMessage(err)})`)
  }
  const password = withoutOneNewline(text)
  if (password.trim() === "") return refused(`${named}, which holds no password`)
  return { ok: true, file: { path, password } }
}

/**
 * Where this project's keyspace password comes from, read the way compose reads `.env` with the
 * shell over it. A stack that uses no password is still refused both forms in `.env`, since the
 * server reads `.env` whether or not the stack hands it a password.
 */
export function keyspacePasswordSource(
  cwd: string,
  use: KeyspacePasswordUse,
  shell: NodeJS.ProcessEnv = process.env,
): KeyspacePasswordSource {
  const dotenv = readEnvFile(cwd)
  const both = bothSetProblem(dotenv, use.required ? shell : {})
  if (both !== undefined) return both
  const named = use.required ? setValue(KEYSPACE_PASSWORD_FILE_ENV, dotenv, shell) : undefined
  if (named === undefined) return { ok: true, file: undefined }
  if (use.tls) return TLS_PROBLEM
  return readPasswordFile(resolve(cwd, named.value))
}

/** {@link keyspacePasswordSource}'s file, exiting with its problem when there is one. */
export function checkedKeyspacePasswordFile(
  cwd: string,
  use: KeyspacePasswordUse,
  fatal?: FatalOptions,
): KeyspacePasswordFile | undefined {
  const source = keyspacePasswordSource(cwd, use)
  if (!source.ok) fatalError(source.problem, source.hints, fatal)
  return source.file
}

/**
 * Native dev's keyspace password: the file's when the project names one, else `.env`'s, generated
 * there first. Native writes it to a file of its own for Postgres either way (native-keyspace.ts).
 */
export function projectKeyspacePassword(cwd: string): string {
  return checkedKeyspacePasswordFile(cwd, { required: true, tls: false })?.password ?? ensureKeyspacePassword(cwd)
}

/** Whether the shell names a keyspace password file, which is all `init` has before .env exists. */
export function shellNamesKeyspacePasswordFile(shell: NodeJS.ProcessEnv = process.env): boolean {
  return setValue(KEYSPACE_PASSWORD_FILE_ENV, {}, shell) !== undefined
}

/** Where dev says the keyspace password came from. */
export function keyspacePasswordOrigin(cwd: string, shell: NodeJS.ProcessEnv = process.env): string {
  const named = setValue(KEYSPACE_PASSWORD_FILE_ENV, readEnvFile(cwd), shell)
  return named === undefined ? `${KEYSPACE_PASSWORD_ENV} in .env` : `the file ${KEYSPACE_PASSWORD_FILE_ENV} names`
}
