"use client"

import React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { LoginForm } from "@supatype/react-auth"

export default function LoginPage(): React.ReactElement {
  const router = useRouter()
  const next = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("next") ?? "/"
    : "/"

  return (
    <div className="auth-page">
      <LoginForm
        onSuccess={() => { router.push(next) }}
        labels={{ title: "Welcome back" }}
      />
      <p>
        Don&apos;t have an account? <Link href="/signup">Sign up</Link>
      </p>
    </div>
  )
}
