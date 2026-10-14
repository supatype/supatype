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
 * Take `anon` and `authenticated` out of the default privileges on tables in `public`, for every
 * role that has some (CL-N2). A table made by hand was otherwise readable by anyone with the anon
 * key, as it no longer is on Cloud (CL1). A model table's grants are the engine's, written from the
 * schema's access rules, so nothing a schema declares depends on these defaults. Idempotent, and
 * run as a superuser, which may alter another role's defaults.
 */
export const PRIVATE_TABLE_DEFAULTS_SQL = `DO $$
DECLARE owner_role text;
BEGIN
  FOR owner_role IN
    SELECT DISTINCT pg_get_userbyid(defaclrole) FROM pg_default_acl
    WHERE defaclnamespace = 'public'::regnamespace AND defaclobjtype = 'r'
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated',
      owner_role
    );
  END LOOP;
END $$;
`

/**
 * The script. `withMask` adds the `supatype_mask` extension, for a Postgres build that bundles it.
 *
 * `authenticator` is created outside the `DO` block because psql does not substitute its
 * variables inside a dollar-quoted body; `\gexec` runs the `CREATE ROLE` only when the role is
 * missing. Its password is then set from `.env` every time: the cluster checks passwords, and a
 * role made before it did has whatever password it was given then.
 */
export function nativeRolesSql(withMask: boolean): string {
  return `${withMask ? "CREATE EXTENSION IF NOT EXISTS supatype_mask;\n" : ""}CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
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
SELECT format('ALTER ROLE authenticator PASSWORD %L', :'authenticator_password') \\gexec
GRANT anon, authenticated, service_role TO postgres;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Where the engine installs PostGIS, pgvector and unaccent: a request resolves a column's type and
-- a filter's operator through it, and PostgREST's extra search path names it.
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
-- Tables are service_role's by default. anon and authenticated get a model table's grants from
-- the engine, as the schema's access rules say, and nothing on a table made by hand (CL-N2).
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;
${PRIVATE_TABLE_DEFAULTS_SQL}`
}
