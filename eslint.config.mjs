// The one lint rule this repository enforces: no `any`, explicit or otherwise.
//
// Deliberately narrow. No preset is spread in, so nothing but the rule below is on, and the parser
// runs without type information so the whole tree lints in seconds. Implicit `any` is the compiler's
// job: every tsconfig here sets `strict`, which includes `noImplicitAny`.
//
// `noInlineConfig` makes every `eslint-disable` comment inert, so the rule cannot be switched off for a
// line or a file. The comments already in the tree (react-hooks notes, deno.d.ts headers) then lint as
// warnings, which `pnpm lint` runs `--quiet` to leave out of the output.
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
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
      "**/target/**",
      "**/release-bundle/**",
      "**/artifacts/**",
      // Written by `supatype generate`; the generator in packages/cli is what gets linted.
      "**/supatype/generated/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tseslint.parser,
      sourceType: "module",
    },
    linterOptions: {
      noInlineConfig: true,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];
