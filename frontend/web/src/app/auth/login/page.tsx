import { Suspense } from "react";
import { LoginForm } from "@/modules/auth";

export default function LoginPage() {
  // LoginForm reads useSearchParams() (for ?confirmed=1) — Next.js requires
  // that inside a Suspense boundary.
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
