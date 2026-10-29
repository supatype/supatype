/**
 * Offer to keep a dev database port given only in the shell.
 *
 * `SUPATYPE_DEV_DB_PORT=54339 supatype dev` moves Postgres for that run, and `DATABASE_URL` with it,
 * in dev's own environment only (DR9). Every other shell kept reading `.env`'s URL, on a port where
 * nothing listened, so `admin list-users` and `seed --status` failed from beside a running stack
 * (local test C). Dev now asks whether the port is the project's. Yes writes it to `.env` with the
 * URL moved to match, by the same code a self-host push uses for `SUPATYPE_DB_PORT`. No keeps it for
 * the run. With nobody to answer, nothing is written: one line names what to add.
 */
import { databaseUrlPortMove, DEV_DB_PORT_ENV, shellOnlyPort, writeDatabaseUrlPort } from "./db-port.js"
import { setInShell } from "./shell-ports.js"
import { confirm } from "./ui/confirm.js"
import { isInteractive } from "./ui/interactive.js"

/** Who can be asked, and how. */
export interface DbPortAsk {
  interactive: () => boolean
  confirm: (question: string) => Promise<boolean>
}

const TERMINAL: DbPortAsk = {
  interactive: isInteractive,
  confirm: (question) => confirm(question, { default: false }),
}

/** A port only the shell gives, and the `DATABASE_URL` port in `.env` it differs from. */
interface ShellOnlyDbPort {
  port: number
  from: string
}

/**
 * The shell's dev database port, when `.env` does not hold it and `.env`'s `DATABASE_URL` names this
 * machine on another port. Not when the shell sets `DATABASE_URL` too: that one is the shell's.
 */
function shellOnlyDbPort(cwd: string, shell: NodeJS.ProcessEnv): ShellOnlyDbPort | null {
  const port = shellOnlyPort(cwd, DEV_DB_PORT_ENV, shell)
  if (port === null || setInShell(shell, "DATABASE_URL")) return null
  const move = databaseUrlPortMove(cwd, port)
  return move === null ? null : { port, from: move.from }
}

/** Ask, or say, what keeps a dev database port given only in the shell; see the file's comment. */
export async function offerToSaveShellDbPort(
  cwd: string,
  ask: DbPortAsk = TERMINAL,
  shell: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const change = shellOnlyDbPort(cwd, shell)
  if (change === null) return
  const line = `${DEV_DB_PORT_ENV}=${change.port}`
  const situation = `${line} is set in this shell only, so commands run from other shells read port ${change.from} from .env's DATABASE_URL.`
  if (!ask.interactive()) {
    console.log(`[supatype] ${situation} To keep it, add this line to .env: ${line}`)
    return
  }
  const save = await ask.confirm(`${situation} Save port ${change.port} to .env?`)
  if (save) {
    writeDatabaseUrlPort(cwd, change.port, { [DEV_DB_PORT_ENV]: String(change.port) })
    console.log(`[supatype] Saved ${line} to .env, and DATABASE_URL port ${change.from} -> ${change.port}.`)
    return
  }
  console.log(`[supatype] Using port ${change.port} for this run only. .env keeps port ${change.from}.`)
}
