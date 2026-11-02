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
 * PostgREST's schema-cache event triggers, as the image installs them (supatype-postgres:
 * 20220126121436_finer-postgrest-triggers.sql and 20220321174452_fix-postgrest-alter-type-event-trigger.sql).
 * Without them a model added while native dev runs is invisible to REST (PGRST205) until PostgREST
 * reloads. Idempotent, so an existing data directory gets them at its next start.
 */
export const PGRST_WATCH_SQL = `CREATE OR REPLACE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE', 'ALTER TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type IN (
      'schema'
    , 'table'
    , 'foreign table'
    , 'view'
    , 'materialized view'
    , 'function'
    , 'trigger'
    , 'type'
    , 'rule'
    )
    AND obj.is_temporary IS false -- no pg_temp objects
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

DROP EVENT TRIGGER IF EXISTS pgrst_ddl_watch;
CREATE EVENT TRIGGER pgrst_ddl_watch
  ON ddl_command_end
  EXECUTE PROCEDURE extensions.pgrst_ddl_watch();

DROP EVENT TRIGGER IF EXISTS pgrst_drop_watch;
CREATE EVENT TRIGGER pgrst_drop_watch
  ON sql_drop
  EXECUTE PROCEDURE extensions.pgrst_drop_watch();
`

/**
 * The `postgres` role's search_path, as the image sets it (supatype-postgres,
 * init-scripts/00000000000003-post-setup.sql), so an extension's types in `extensions` (vector, for
 * one) resolve by name. The server no longer sets a database-level path. Only when the role has no
 * path of its own, so one an operator set is kept; every other role keeps Postgres's default.
 */
export const POSTGRES_SEARCH_PATH_SQL = `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_db_role_setting s, unnest(s.setconfig) AS c
     WHERE s.setdatabase = 0 AND s.setrole = 'postgres'::regrole AND c LIKE 'search_path=%'
  ) THEN
    ALTER ROLE postgres SET search_path TO "$user",public,extensions;
  END IF;
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
-- PostgREST is told to serve graphql_public (STACK_API_SCHEMAS) and answers 503 on every request
-- when a schema in its list is missing. The image's pg_graphql migration creates it; a native
-- Postgres has no pg_graphql, so it is created here, empty, and /graphql/v1 finds no function.
CREATE SCHEMA IF NOT EXISTS graphql_public;
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
GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;
-- Where the engine installs PostGIS, pgvector and unaccent: a request resolves a column's type and
-- a filter's operator through it, and PostgREST's extra search path names it.
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
-- Tables are service_role's by default. anon and authenticated get a model table's grants from
-- the engine, as the schema's access rules say, and nothing on a table made by hand (CL-N2).
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;
${PRIVATE_TABLE_DEFAULTS_SQL}${PGRST_WATCH_SQL}${POSTGRES_SEARCH_PATH_SQL}`
}
