/**
 * Stand-ins for third-party modules a docs block imports alongside ours.
 *
 * The migration guide shows Supabase and Supatype side by side. Installing Supabase to check our
 * half of that comparison would be silly, but skipping the block would leave our half unchecked,
 * so the foreign module is declared just loosely enough to compile. Nothing here describes a
 * Supatype API; if you find yourself adding a `@supatype/*` entry, the block is testing the stub
 * instead of the package.
 */
declare module "@supabase/supabase-js" {
  export function createClient(url: string, key: string): SupabaseLike
  interface SupabaseLike {
    from(table: string): SupabaseQuery
    auth: {
      signInWithPassword(credentials: { email: string; password: string }): Promise<unknown>
      signOut(): Promise<unknown>
      getUser(): Promise<unknown>
    }
  }
  interface SupabaseQuery {
    select(columns?: string): SupabaseQuery
    insert(values: unknown): SupabaseQuery
    update(values: unknown): SupabaseQuery
    delete(): SupabaseQuery
    eq(column: string, value: unknown): SupabaseQuery
    order(column: string, options?: { ascending?: boolean }): SupabaseQuery
    limit(n: number): SupabaseQuery
    single(): Promise<{ data: unknown; error: unknown }>
    then(onfulfilled: (value: { data: unknown; error: unknown }) => unknown): Promise<unknown>
  }
}

declare module "@supabase/auth-helpers-react" {
  export function useUser(): { id: string; email?: string } | null
  export function useSession(): { access_token: string } | null
  export function useSupabaseClient(): unknown
}

// The Expo modules the React Native examples pass to our packages, declared as their documented
// signatures, which is all @supatype/react-native reads from them.
declare module "expo-secure-store" {
  export function getItemAsync(key: string): Promise<string | null>
  export function setItemAsync(key: string, value: string): Promise<void>
  export function deleteItemAsync(key: string): Promise<void>
}

declare module "expo-web-browser" {
  export function openAuthSessionAsync(url: string, redirectUrl?: string): Promise<{ type: string; url?: string }>
  export function maybeCompleteAuthSession(): { type: string }
}

declare module "expo-linking" {
  export function createURL(path: string): string
  export function getInitialURL(): Promise<string | null>
  export function addEventListener(type: "url", handler: (event: { url: string }) => void): { remove(): void }
}
