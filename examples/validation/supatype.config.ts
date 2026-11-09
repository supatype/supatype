import { defineConfig } from "@supatype/cli"

/**
 * Field validation demo. No front end: Studio is the UI that shows the feature.
 *
 * Workflow: `pnpm keys` → `pnpm dev`, then open Studio and try to save a Product that breaks a rule.
 * Each of the three mechanisms fails differently and says so in a different place.
 */
export default defineConfig({
  project: { name: "validation" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54460 },
  // No front end: `/` returns 404 and Studio is the UI. The feature under test is what a form does
  // before a write, and Studio is the form.
  app: { mode: "none" },
  email: { provider: "console" },
  // Sign-ups confirmed at once on every stack. tests/integration/scripts/validation-e2e.sh runs this
  // project as a self-hosted (standalone) stack, which otherwise sends a confirmation link, and
  // signs up and straight in.
  auth: { email: { enableConfirmations: false } },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  output: {
    types: "supatype/generated/database.ts",
    client: "supatype/generated/index.d.ts",
  },
})
