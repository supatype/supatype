/**
 * Where `supatype push` writes a project's generated client, as an app imports it from the project
 * root. Messages that tell someone to import the generated client name it from here, so they cannot
 * drift from each other when the path changes.
 */
export const GENERATED_CLIENT_IMPORT = "./supatype/generated/client"
