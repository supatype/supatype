"use client"

import React from "react"
import { useRouter } from "next/navigation"
import { LoginForm } from "@supatype/react-auth"

export default function LoginPage(): React.ReactElement {
  const router = useRouter()

  return (
    <div style={{ maxWidth: "400px", margin: "4rem auto" }}>
      <LoginForm
        onSuccess={() => { router.push("/") }}
        labels={{ title: "Welcome back" }}
      />
      <p style={{ marginTop: "1rem", textAlign: "center" }}>
        Don&apos;t have an account? <a href="/signup">Sign up</a>
      </p>
    </div>
  )
}
