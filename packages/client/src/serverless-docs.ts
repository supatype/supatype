/**
 * Serverless connection documentation — Gap Appendices task 84
 *
 * Code-accessible documentation for connection modes.
 * Rendered in Studio's getting-started view and available to CLI help output.
 */

export interface ConnectionModeDoc {
  /** Short label for this mode. */
  label: string
  /** When to use this mode (environment/context). */
  recommended: string
  /** Whether this mode is safe in serverless contexts. */
  serverlessSafe: boolean
  /** How it handles connection pooling. */
  pooling: string
  /** Brief description. */
  description: string
  /** Example code snippet (TypeScript). */
  example: string
}

/**
 * Documents the two primary ways to connect to a Supatype project,
 * with clear guidance on serverless vs. long-lived server environments.
 */
export const CONNECTION_MODES: readonly ConnectionModeDoc[] = [
  {
    label: "Supatype SDK (via PostgREST)",
    recommended: "Serverless environments: Next.js API routes, Vercel Edge Functions, AWS Lambda, Cloudflare Workers, Deno Deploy",
    serverlessSafe: true,
    pooling: "PostgREST maintains a persistent connection pool to Postgres. Each SDK request is an HTTP call that reuses an existing database connection from the pool.",
    description:
      "Use the Supatype SDK in serverless environments. PostgREST handles connection pooling for you. " +
      "Each serverless invocation makes an HTTP request to PostgREST, which maps it to a pre-established " +
      "database connection. This avoids the connection-per-invocation problem entirely.",
    example: [
      'import { createClient } from "@supatype/client"',
      "",
      "const client = createClient(process.env.SUPATYPE_URL!, process.env.SUPATYPE_ANON_KEY!)",
      "",
      "// Safe in serverless — each call is an HTTP request, not a new DB connection",
      "const users = await client.from(\"users\").select()",
    ].join("\n"),
  },
  {
    label: "Direct database connection",
    recommended: "Long-lived servers: Express/Fastify/Hono on a VM or container, background workers, migration scripts, CLI tools",
    serverlessSafe: false,
    pooling: "Each new connection opens a TCP socket to Postgres. In serverless, each invocation creates a new connection that is never reused, exhausting the connection pool within seconds under load.",
    description:
      "Do NOT use direct database connections from serverless environments. " +
      "Each invocation opens a new connection, which will exhaust your connection pool " +
      "within seconds under load. Direct connections are only appropriate for long-lived " +
      "server processes that open a connection once and reuse it across many requests.",
    example: [
      '// ONLY for long-lived servers — NOT for serverless',
      'import pg from "pg"',
      "",
      "const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })",
      "",
      "// Connection is reused across requests in a long-lived process",
      "const result = await pool.query(\"SELECT * FROM users\")",
    ].join("\n"),
  },
] as const

/**
 * A short, actionable warning suitable for display in Studio banners,
 * CLI output, and getting-started guides.
 */
export const SERVERLESS_CONNECTION_WARNING =
  "Use the Supatype SDK (via PostgREST) in serverless environments (Next.js API routes, " +
  "Vercel Edge Functions, AWS Lambda). PostgREST handles connection pooling for you. " +
  "Do NOT use direct database connections from serverless — each invocation opens a new " +
  "connection, which will exhaust your connection pool within seconds under load."

/**
 * Structured FAQ entries for the connection modes documentation.
 */
export const CONNECTION_FAQ: ReadonlyArray<{ question: string; answer: string }> = [
  {
    question: "Can I use Prisma/Drizzle/Knex in serverless?",
    answer:
      "These ORMs require a direct database connection. In serverless, use the Supatype SDK instead. " +
      "If you must use an ORM, deploy it on a long-lived server (container, VM) or use a connection " +
      "pooler like PgBouncer in transaction mode.",
  },
  {
    question: "What about Edge Functions?",
    answer:
      "Edge Functions (Vercel Edge, Cloudflare Workers) are serverless. Use the Supatype SDK. " +
      "Direct TCP connections are not available in most edge runtimes anyway.",
  },
  {
    question: "How many connections does PostgREST use?",
    answer:
      "PostgREST maintains a configurable pool (default: 10 connections). All incoming HTTP requests " +
      "share this pool, so even thousands of concurrent SDK requests only use 10 database connections.",
  },
  {
    question: "When should I use a direct connection?",
    answer:
      "Use direct connections for: migration scripts, long-lived API servers (Express, Fastify), " +
      "background job processors, and CLI tooling. These processes start once and reuse connections.",
  },
]
