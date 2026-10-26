// The one thing this repository lints for: `any`, written or inherited.
//
// Deliberately narrow. No preset is spread in, so nothing but the rules below is on.
// `no-explicit-any` stops `any` being written; the five `no-unsafe-*` rules stop it arriving from a
// library (an untyped package, a loosely typed callback) and flowing on unchecked; and
// `no-unsafe-type-assertion` stops a cast narrowing a value to a type nobody checked, which is how
// `unknown` would otherwise be laundered back into one. `res.json()` and `JSON.parse` return `unknown`
// here (ts-reset.d.ts), so what they read is narrowed by a guard instead.
//
// These rules need type information, so the parser runs with the TypeScript project service, which
// gives each file the nearest tsconfig.json that includes it. Every TypeScript file in the repository
// is in one: a package's own, or the root tsconfig.json for the config files beside a package's build
// config. Implicit `any` is the compiler's job: every tsconfig here sets `strict`.
//
// `.vue` and `.svelte` files get the same rules: their framework parser hands each script block to the
// TypeScript parser, typed like any other file.
//
// `noInlineConfig` makes every `eslint-disable` comment inert, so no rule can be switched off for a
// line or a file. Such a comment lints as a warning; `pnpm lint` runs `--quiet`, which hides every
// warning, so a rule added here later must be an error to be seen.
import * as svelteParser from "svelte-eslint-parser";
import tseslint from "typescript-eslint";
import * as vueParser from "vue-eslint-parser";

const typedParserOptions = {
  projectService: true,
  tsconfigRootDir: import.meta.dirname,
  extraFileExtensions: [".vue", ".svelte"],
};

const anyRules = {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-type-assertion": "error",
};

/** The parser for a framework's own file type, with TypeScript parsing its script blocks. */
function frameworkFiles(extension, parser) {
  return {
    files: [`**/*${extension}`],
    languageOptions: {
      parser,
      parserOptions: { ...typedParserOptions, parser: tseslint.parser },
    },
  };
}

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
    languageOptions: { parser: tseslint.parser, parserOptions: typedParserOptions },
  },
  frameworkFiles(".vue", vueParser),
  frameworkFiles(".svelte", svelteParser),
  {
    files: ["**/*.{ts,tsx,mts,cts,vue,svelte}"],
    linterOptions: { noInlineConfig: true },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: anyRules,
  },
];
