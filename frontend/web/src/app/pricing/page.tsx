import Link from "next/link";
import { PlanCards } from "@/features/billing/PlanCards";
export const metadata = { title: "Pricing — JobTrackr" };

/**
 * Public pricing page. The subscribe buttons POST to /api/billing/checkout;
 * if the visitor isn't logged in the route returns 401 and PlanCards redirects
 * them to sign up first.
 */
export default function PricingPage() {
  return (
    <div className="min-h-screen bg-bg px-4 sm:px-6 py-12">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <img src="/logo-wordmark.png" alt="JobTrackr" style={{ height: 30, width: "auto", objectFit: "contain" }} />
          </Link>
          <Link href="/auth/login" className="text-sm font-medium text-text-2 hover:text-text">
            Sign in
          </Link>
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold text-text">Simple, honest pricing</h1>
          <p className="mt-2 text-sm text-text-2">
            Start with a 3-day free trial — cancel anytime before it ends.
          </p>
        </div>

        <PlanCards showTrial currentPlan={null} />
      </div>
    </div>
  );
}
