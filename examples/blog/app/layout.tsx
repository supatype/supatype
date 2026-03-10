"use client"

import React from "react"
import { SupatypeProvider } from "@supatype/react"
import { supatype } from "@/lib/supatype"

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <SupatypeProvider client={supatype}>
          <header style={{ padding: "1rem 2rem", borderBottom: "1px solid #eee", display: "flex", gap: "1rem", alignItems: "center" }}>
            <a href="/" style={{ fontWeight: "bold", textDecoration: "none", color: "inherit" }}>Supatype Blog</a>
            <nav style={{ marginLeft: "auto", display: "flex", gap: "1rem" }}>
              <a href="/login">Sign in</a>
              <a href="/signup">Sign up</a>
              <a href="/posts/new">New post</a>
            </nav>
          </header>
          <main style={{ maxWidth: "800px", margin: "2rem auto", padding: "0 1rem" }}>
            {children}
          </main>
        </SupatypeProvider>
      </body>
    </html>
  )
}
