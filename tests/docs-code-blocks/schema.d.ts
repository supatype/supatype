/**
 * Stands in for `supatype/generated/index.d.ts`, the file `supatype push` writes into a reader's
 * project and this repo does not have.
 *
 * Types reach the client by **module augmentation**, not by importing a `Database` type, so a docs
 * block calling `supatype.from("posts")` only typechecks if something has augmented
 * `SupatypeModels`. Without this file the honest options would both be wrong: annotate every
 * example with type arguments no real project needs, or exempt them from checking.
 *
 * Written in the exact shape the generator emits (`Row` / `Insert` / `Update` per table, insert
 * columns optional where a default or server-generated value exists). Keep the tables here in step
 * with the ones the examples use.
 */
import "@supatype/client"
import type { SerializedEditorState } from "@supatype/types/lexical"

declare module "@supatype/client" {
  interface SupatypeModels {
    posts: {
      Row: {
        id: string
        title: string
        body: string
        slug: string
        status: string
        author_id: string
        published_at: string | null
        created_at: string
        updated_at: string
      }
      Insert: {
        id?: string
        title: string
        body: string
        slug?: string
        status?: string
        author_id: string
        published_at?: string | null
        created_at?: string
        updated_at?: string
      }
      Update: {
        id?: string
        title?: string
        body?: string
        slug?: string
        status?: string
        author_id?: string
        published_at?: string | null
        created_at?: string
        updated_at?: string
      }
    }
    // `post` and `comment` are the schema page's `Post` and `Comment` models, the schema the main
    // docs pages use, as the generator writes them: a rich text column reads as a Lexical document
    // and accepts plain prose on the way in.
    post: {
      Row: {
        id: string
        title: string
        slug: string
        body: SerializedEditorState
        kind: "news" | "guide"
        cover: { bucket: string; path: string } | null
        author_id: string
        views: number
        published_at: string | null
      }
      Insert: {
        id?: string
        title: string
        slug?: string
        body: SerializedEditorState | string
        kind: "news" | "guide"
        cover?: { bucket: string; path: string } | null
        author_id: string
        views?: number
        published_at?: string | null
      }
      Update: {
        id?: string
        title?: string
        slug?: string
        body?: SerializedEditorState | string
        kind?: "news" | "guide"
        cover?: { bucket: string; path: string } | null
        author_id?: string
        views?: number
        published_at?: string | null
      }
    }
    comment: {
      Row: { id: string; post_id: string; user_id: string; body: string }
      Insert: { id?: string; post_id: string; user_id: string; body: string }
      Update: { id?: string; post_id?: string; user_id?: string; body?: string }
    }
    comments: {
      Row: { id: string; body: string; post_id: string; author_id: string; created_at: string }
      Insert: { id?: string; body: string; post_id: string; author_id: string; created_at?: string }
      Update: { id?: string; body?: string; post_id?: string; author_id?: string; created_at?: string }
    }
    profiles: {
      Row: { id: string; display_name: string; avatar_url: string | null; created_at: string }
      Insert: { id: string; display_name: string; avatar_url?: string | null; created_at?: string }
      Update: { id?: string; display_name?: string; avatar_url?: string | null; created_at?: string }
    }
    employees: {
      Row: { id: string; name: string; salary: number | null; user_id: string }
      Insert: { id?: string; name: string; salary?: number | null; user_id: string }
      Update: { id?: string; name?: string; salary?: number | null; user_id?: string }
    }
    documents: {
      Row: { id: string; title: string; owner_id: string; created_at: string }
      Insert: { id?: string; title: string; owner_id: string; created_at?: string }
      Update: { id?: string; title?: string; owner_id?: string; created_at?: string }
    }
  }
}

// No bucket entries: `SupatypeBuckets` exists in the client but nothing consumes it yet, so a
// bucket name is an unconstrained string and declaring one here would check nothing.
