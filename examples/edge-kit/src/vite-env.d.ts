/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPATYPE_URL: string
  readonly VITE_SUPATYPE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
