import Link from "next/link";

export const metadata = { title: "Terms of Service — JobTrackr" };

// TODO: Replace the placeholder body below with real Terms of Service content
// (reviewed by a lawyer) BEFORE enabling live payments in Stripe. This route
// exists so the URL is indexable and not a 404, but the terms themselves are
// not yet written. Shipping placeholder terms while taking payment is a legal
// gap, not a technical one.
export default function TermsPage() {
  return (
    <main className="min-h-screen bg-bg text-text-2">
      <header className="border-b border-border px-6 py-4">
        <Link href="/" className="text-xl font-medium text-text hover:text-brand transition-colors tracking-tight">
          JobTrackr
        </Link>
      </header>

      <article className="max-w-2xl mx-auto px-6 py-12 space-y-8 text-base leading-relaxed">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-text-3 hover:text-text transition-colors"
        >
          ← Back to home
        </Link>
        <div>
          <h1 className="text-3xl font-medium text-text mb-3 tracking-tight">Terms of Service</h1>
          <p className="text-text-3">Applies to jobtrackr.app</p>
        </div>

        <section className="space-y-3">
          <p>
            Our full Terms of Service are being finalized. If you have any questions about using
            JobTrackr in the meantime, please contact us at{" "}
            <a href="mailto:privacy@jobtrackr.com.au" className="text-brand hover:text-text transition-colors">
              privacy@jobtrackr.com.au
            </a>
            .
          </p>
          <p className="text-text-3">
            See our{" "}
            <Link href="/privacy" className="text-brand hover:text-text transition-colors">
              Privacy Policy
            </Link>{" "}
            for how we handle your data.
          </p>
        </section>
      </article>
    </main>
  );
}
