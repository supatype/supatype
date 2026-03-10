"use client"

import React from "react"
import { useRouter } from "next/navigation"
import { SignUpForm } from "@supatype/react-auth"

export default function SignUpPage(): React.ReactElement {
  const router = useRouter()

  return (
    <div style={{ maxWidth: "400px", margin: "4rem auto" }}>
      <SignUpForm
        onSuccess={(session) => {
          if (session !== null) {
            router.push("/")
          }
          // if session is null, email confirmation required — form shows success message
        }}
        labels={{ title: "Create your account" }}
      />
      <p style={{ marginTop: "1rem", textAlign: "center" }}>
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </div>
  )
}
