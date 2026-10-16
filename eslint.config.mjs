// The one thing this repository lints for: `any`, written or inherited.
//
// Deliberately narrow. No preset is spread in, so nothing but the rules below is on.
// `no-explicit-any` stops `any` being written; the five `no-unsafe-*` rules stop it arriving from a
// library (`JSON.parse`, `res.json()`, an untyped package) and flowing on unchecked. Those five need
// type information, so the parser runs with the TypeScript project service, which finds each file's
// nearest tsconfig.json. Implicit `any` is the compiler's job: every tsconfig here sets `strict`.
//
// `.vue`, `.svelte` and `.astro` files get the same rules: their framework parser hands each script
// block to the TypeScript parser, typed like any other file.
//
// `noInlineConfig` makes every `eslint-disable` comment inert, so no rule can be switched off for a
// line or a file. Such a comment lints as a warning; `pnpm lint` runs `--quiet`, which hides every
// warning, so a rule added here later must be an error to be seen.
import * as astroParser from "astro-eslint-parser";
import * as svelteParser from "svelte-eslint-parser";
import tseslint from "typescript-eslint";
import * as vueParser from "vue-eslint-parser";

const extraFileExtensions = [".vue", ".svelte", ".astro"];

const typedParserOptions = {
  projectService: {
    // Every other file is in the tsconfig.json nearest to it, which is also what typechecks it. These
    // few sit beside a package's build config (whose `rootDir` is `src`) with no tsconfig of their
    // own, so they are typed against the base options instead. Single-star globs only: the project
    // service refuses `**` here, and a new file that matches none of these fails the lint until it is
    // given a tsconfig.
    allowDefaultProject: [
      "packages/*/vitest.config.ts",
      "packages/*/vite.config.ts",
      "packages/studio/tailwind.*.ts",
      "packages/cli/bin/*.ts",
      "packages/cli/deno.d.ts",
    ],
    defaultProject: "tsconfig.base.json",
  },
  tsconfigRootDir: import.meta.dirname,
  extraFileExtensions,
};

const anyRules = {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
};

/** The parser for a framework's own file type, with TypeScript parsing its script blocks. */
function frameworkFiles(extension, parser, typed = typedParserOptions) {
  return {
    files: [`**/*${extension}`],
    languageOptions: {
      parser,
      parserOptions: { ...typed, parser: tseslint.parser },
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
    languageOptions: { parser: tseslint.parser, parserOptions: typedParserOptions },
  },
  frameworkFiles(".vue", vueParser),
  frameworkFiles(".svelte", svelteParser),
  // astro-eslint-parser does not take the project service: it warns and falls back to `project: true`,
  // which finds the same nearest tsconfig.json for each file, so that is asked for directly.
  frameworkFiles(".astro", astroParser, {
    project: true,
    tsconfigRootDir: import.meta.dirname,
    extraFileExtensions,
  }),
  {
    files: ["**/*.{ts,tsx,mts,cts,vue,svelte,astro}"],
    linterOptions: { noInlineConfig: true },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: anyRules,
  },
];
