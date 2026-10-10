/**
 * The roles and grants native `supatype dev` sets up in a new local database.
 *
 * Run through `psql -f -` with the script on stdin and `SUPATYPE_AUTHENTICATOR_PASSWORD` in psql's
 * environment, read with `\getenv`. The password is never in the script text or on psql's command
 * line, where any local user could read it from the process list.
 */

/** The environment variable the script reads the authenticator password from. */
export const AUTHENTICATOR_PASSWORD_ENV = "SUPATYPE_AUTHENTICATOR_PASSWORD"

/**
 * The script. `withMask` adds the `supatype_mask` extension, for a Postgres build that bundles it.
 *
 * `authenticator` is created outside the `DO` block because psql does not substitute its
 * variables inside a dollar-quoted body; `\gexec` runs the `CREATE ROLE` only when the role is
 * missing.
 */
export function nativeRolesSql(withMask: boolean): string {
  return `${withMask ? "CREATE EXTENSION IF NOT EXISTS supatype_mask;\n" : ""}CREATE SCHEMA IF NOT EXISTS auth;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon')
    THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated')
    THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role')
    THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
\\getenv authenticator_password ${AUTHENTICATOR_PASSWORD_ENV}
SELECT format('CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD %L', :'authenticator_password')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') \\gexec
GRANT anon, authenticated, service_role TO postgres;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Table-level privileges (RLS restricts rows; roles still need table access)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
-- Default privileges so tables created by the engine push inherit these grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;
`
}
