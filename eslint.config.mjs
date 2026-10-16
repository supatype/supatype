// The one lint rule this repository enforces: no explicit `any` in TypeScript.
//
// Deliberately narrow. No preset is spread in, so nothing but the rule below is on, and the parser
// runs without type information so the whole tree lints in seconds. Implicit `any` is the compiler's
// job: every tsconfig here sets `strict`, which includes `noImplicitAny`.
//
// `noInlineConfig` makes every `eslint-disable` comment inert, so the rule cannot be switched off for a
// line or a file. The comments already in the tree (react-hooks notes, deno.d.ts headers) then lint as
// warnings. `pnpm lint` runs `--quiet`, which hides every warning, so a rule added here later must be
// an error to be seen.
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      // Plain JavaScript has no types to check; ESLint would otherwise parse it for no rule.
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/dist/**",
      "**/dist-app/**",
      "**/build/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.astro/**",
      "**/.expo/**",
      "**/.svelte-kit/**",
      "**/.turbo/**",
      "**/.supatype/**",
      "**/release-bundle/**",
      "**/artifacts/**",
      // Written by `supatype generate`; the generator in packages/cli is what gets linted.
      "**/supatype/generated/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { noInlineConfig: true },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
];
