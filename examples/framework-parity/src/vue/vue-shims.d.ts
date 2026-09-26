/**
 * Tell TypeScript what a `.vue` file is.
 *
 * Without this, `import App from "./App.vue"` is an unresolved module and `tsconfig.vue.json` fails
 * to typecheck, which it had been doing silently: the per-framework configs are not what the
 * example's default `tsconfig.json` checks, so nothing ran this one.
 *
 * `vue-tsc` understands single-file components natively and would not need this. Plain `tsc` does,
 * and plain `tsc` is what the repo's typecheck task runs.
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue"

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
