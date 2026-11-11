/**
 * The lines a psql session runs before any statement that holds a password.
 *
 * psql fills in `:'pw'` before it sends the statement, so the server receives the password as a
 * literal. The Postgres image logs every DDL statement in full (`log_statement = 'ddl'`), and
 * `pg_stat_statements` keeps a utility statement's text with its literals. `supatype dev` printed
 * and saved the db log after a retried push, and `ALTER ROLE authenticator ... PASSWORD '<value>'`
 * was in it: the image turns logging off for `supatype_admin` only once its own setup has run, and
 * dev reconciled the password before that. The image's own `migrate.sh` opens every password
 * session with these same three lines.
 */
export const QUIET_SECRET_SQL =
  "SET log_statement = 'none';\nSET log_min_error_statement = 'panic';\nSET pg_stat_statements.track = 'none';\n"
