import type { JwtClaims } from "./auth.js"

/** The one thing a channel check needs of a database session: run a statement, read its rows. */
export interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>
}

/**
 * How the channel guard reaches the database.
 *
 * Two ways, and the difference is the point. {@link asCaller} runs as the socket's own role with its
 * own claims, so a rule that reads a table is judged exactly as the same read through the API would
 * be. {@link asService} runs as the service's own login, for the questions that are about the
 * project and not about a caller: its mode, its content checks, which tables its rules read.
 *
 * An interface so a test can stand in a database that counts what it is asked.
 */
export interface ChannelDatabase {
  /** Run `run` in one transaction as `claims`, rolled back afterwards: a check never writes. */
  asCaller<T>(claims: JwtClaims, run: (q: Queryable) => Promise<T>): Promise<T>
  /** Run `run` on one connection as the service's own role. */
  asService<T>(run: (q: Queryable) => Promise<T>): Promise<T>
}
