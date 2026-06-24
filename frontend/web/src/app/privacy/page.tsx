import Link from "next/link";

export const metadata = { title: "Privacy Policy — JobTrackr" };

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-bg text-text-2">
      <header className="border-b border-border px-6 py-4">
        <Link href="/" className="text-xl font-medium text-text hover:text-brand transition-colors tracking-tight">
          JobTrackr
        </Link>
      </header>

      <article className="max-w-2xl mx-auto px-6 py-12 space-y-8 text-base leading-relaxed">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-text-3 hover:text-text transition-colors"
        >
          ← Back to dashboard
        </Link>
        <div>
          <h1 className="text-3xl font-medium text-text mb-3 tracking-tight">Privacy Policy</h1>
          <p className="text-text-3">Effective: May 2026 · Applies to jobtrackr.app</p>
        </div>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">1. Who we are</h2>
          <p>
            JobTrackr is an Australian job-search aggregation tool. We aggregate publicly listed job postings
            from third-party career boards, score them using AI, and present them in your personal dashboard.
            We operate under the <strong className="text-text">Australian Privacy Act 1988</strong> and the
            Australian Privacy Principles (APPs).
          </p>
          <p>Contact: <a href="mailto:privacy@jobtrackr.com.au" className="text-brand hover:text-text transition-colors">privacy@jobtrackr.com.au</a></p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">2. Information we collect</h2>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li><strong className="text-text">Email address</strong> — via Supabase Auth, used for login and weekly digest emails.</li>
            <li><strong className="text-text">Search preferences</strong> — keywords, location, visa filter mode, and schedule settings you configure.</li>
            <li><strong className="text-text">Job interaction data</strong> — which jobs you mark as applied or dismissed.</li>
            <li><strong className="text-text">Run logs</strong> — timestamps, job counts, and AI token usage per pipeline run.</li>
          </ul>
          <p className="text-text-3">
            We do not collect résumés, government identifiers, payment details, or any sensitive information as
            defined under APP 3.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">3. How we use your information</h2>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>To aggregate and display job listings relevant to your search profile.</li>
            <li>To score job relevance and visa sponsorship likelihood using Claude AI (Anthropic).</li>
            <li>To send the weekly job digest email (opt-out by pausing your profile or contacting us).</li>
            <li>To monitor system health and improve the service.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">4. Third-party services</h2>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li><strong className="text-text">Supabase</strong> (database + auth) — stores your account and job data. Data hosted in Sydney (ap-southeast-2).</li>
            <li><strong className="text-text">Anthropic</strong> — job descriptions are sent to the Claude API for scoring. No personal information (name, email) is included in these requests.</li>
            <li><strong className="text-text">Resend</strong> — transactional email delivery.</li>
            <li><strong className="text-text">Fly.io / Upstash</strong> — worker hosting and Redis queue.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">5. Data retention</h2>
          <p>
            Your data is retained for as long as your account is active. You may delete your account
            and all associated data at any time from your account settings. Deletion is permanent and
            processed within 24 hours.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">6. Your rights (APP 12 &amp; 13)</h2>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li><strong className="text-text">Access</strong> — export all your data as JSON from <Link href="/dashboard" className="text-brand hover:text-text transition-colors">Account Settings</Link>.</li>
            <li><strong className="text-text">Correction</strong> — edit your search preferences in the dashboard at any time.</li>
            <li><strong className="text-text">Deletion</strong> — delete your account and all data from Account Settings or by emailing us.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">7. Security</h2>
          <p>
            All data is encrypted in transit (TLS) and at rest. Database access uses row-level security
            so users can only access their own data. We do not store passwords.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">8. Complaints</h2>
          <p>
            If you believe we have mishandled your personal information, contact us at{" "}
            <a href="mailto:privacy@jobtrackr.com.au" className="text-brand hover:text-text transition-colors">privacy@jobtrackr.com.au</a>.
            If unresolved, you may lodge a complaint with the{" "}
            <a href="https://www.oaic.gov.au/" target="_blank" rel="noopener noreferrer" className="text-brand hover:text-text transition-colors">
              Office of the Australian Information Commissioner (OAIC)
            </a>.
          </p>
        </section>
      </article>
    </main>
  );
}
