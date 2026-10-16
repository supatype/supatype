/// <reference types="vite/client" />

/**
 * The build-time variables Studio reads. Vite types every other `import.meta.env` key as `any`, so
 * naming these is what makes a read of one a `string | undefined` rather than an unchecked value.
 */
interface ImportMetaEnv {
  readonly VITE_SUPATYPE_URL?: string
  readonly VITE_SUPATYPE_ANON_KEY?: string
  readonly VITE_SUPATYPE_SERVICE_ROLE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
