"use client"

import Script from "next/script"
import React from "react"
import { SupatypeProvider, useAuth } from "@supatype/react"
import Link from "next/link"
import { supatype } from "@/lib/supatype"
// The package stylesheet goes first so globals.css can override it.
import "@supatype/ui/styles.css"
import "./globals.css"

function SiteNav(): React.ReactElement {
  const { user, loading, signOut } = useAuth()

  return (
    <nav>
      {!loading && user !== null ? (
        <>
          <span className="nav-user">{user.email}</span>
          <Link href="/posts/new">New post</Link>
          <button onClick={() => { void signOut() }} className="nav-link-btn">Sign out</button>
        </>
      ) : (
        <>
          <Link href="/login">Sign in</Link>
          <Link href="/signup">Sign up</Link>
        </>
      )}
    </nav>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body>
        {/* The deployment's address and anon key (app/supatype-env.js/route.ts), before the app runs. */}
        <Script src="/supatype-env.js" strategy="beforeInteractive" />
        <SupatypeProvider client={supatype}>
          <header className="site-header">
            <Link href="/" className="logo">Supatype Blog</Link>
            <SiteNav />
          </header>
          <main className="site-main">
            {children}
          </main>
        </SupatypeProvider>
      </body>
    </html>
  )
}
