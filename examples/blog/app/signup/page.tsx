"use client"

import React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { SignUpForm } from "@supatype/react-auth"

export default function SignUpPage(): React.ReactElement {
  const router = useRouter()

  return (
    <div className="auth-page">
      <SignUpForm
        onSuccess={(session) => {
          if (session !== null) {
            router.push("/")
          }
        }}
        labels={{ title: "Create your account" }}
      />
      <p>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </div>
  )
}
