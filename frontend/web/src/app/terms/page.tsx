import Link from "next/link";

export const metadata = { title: "Terms of Service — JobTrackr" };

// NOTE: This is a complete first draft of the Terms of Service, pending review
// by a lawyer. It still contains bracketed placeholders that must be resolved
// before it is legally final — the operating legal entity name / ABN, the
// governing State/Territory, the liability cap figure, and a dedicated legal
// contact address. Get this reviewed and the placeholders filled BEFORE
// enabling live payments in Stripe.
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
          <p className="text-text-3">Effective: July 2026 · Applies to jobtrackr.app</p>
        </div>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">1. Acceptance of These Terms &amp; Who We Are</h2>
          <p>
            These Terms of Service (<strong className="text-text">Terms</strong>) are an agreement between you and{' '}
            [Legal entity name / ABN — to be confirmed], trading as <strong className="text-text">JobTrackr</strong>{' '}
            (<strong className="text-text">JobTrackr</strong>, <strong className="text-text">we</strong>,{' '}
            <strong className="text-text">us</strong>, <strong className="text-text">our</strong>). They govern your access to
            and use of the JobTrackr website at jobtrackr.app and the related services, features, and tools we provide
            (together, the <strong className="text-text">Service</strong>).
          </p>
          <p>
            By creating an account, or by accessing or using the Service in any way, you agree to be bound by these Terms. If
            you do not agree, you must not use the Service.
          </p>
          <p>
            Our handling of your personal information is governed by our{' '}
            <Link href="/privacy" className="text-brand hover:text-text transition-colors">Privacy Policy</Link>, which forms
            part of these Terms. Please read it together with this document.
          </p>
          <p className="text-text-3">Effective date: July 2026.</p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">2. Eligibility</h2>
          <p>To use the Service, you must:</p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>be at least 18 years old, or the age of majority in the jurisdiction where you live, whichever is higher;</li>
            <li>have the legal capacity to enter into a binding agreement; and</li>
            <li>not be prohibited from using the Service under any applicable law.</li>
          </ul>
          <p>
            By using the Service, you represent that you meet these requirements. If we discover that a user does not meet
            them, we may suspend or close that account.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">3. Accounts &amp; Security</h2>
          <p>
            You can create an account using an email address and password, or by signing in with Google. When you register, you
            must provide information that is accurate and current, and keep it up to date.
          </p>
          <p>You are responsible for your account. In particular, you agree that:</p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>you will keep your login credentials confidential and will not share your account with anyone else;</li>
            <li>you are responsible for all activity that occurs under your account, whether or not you authorised it;</li>
            <li>you will notify us promptly at{' '}
              <a href="mailto:privacy@jobtrackr.com.au" className="text-brand hover:text-text transition-colors">privacy@jobtrackr.com.au</a>{' '}
              if you become aware of any unauthorised access to or use of your account; and</li>
            <li>you will not create an account using false information or on behalf of someone else without their authority.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">4. Description of the Service</h2>
          <p>JobTrackr is a job-search aggregation and application-preparation tool. The Service:</p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>aggregates publicly listed job postings from third-party sources, including career boards such as SEEK,
              Adzuna, Careerjet, Greenhouse, and Lever, as well as direct employer career pages (for example, aged-care
              employers);</li>
            <li>uses artificial intelligence (AI) to score each listing for relevance to your search profile;</li>
            <li>flags signals that a listing may offer visa sponsorship (for example, references to the subclass 482 visa);</li>
            <li>tailors your CV and drafts cover letters and introduction emails against a specific job description; and</li>
            <li>produces an estimated &quot;ATS match score&quot; comparing your CV to a job description.</li>
          </ul>
          <p>
            <strong className="text-text">JobTrackr is an aggregation tool only.</strong> We are not a recruiter, employment
            agent, labour-hire provider, or migration agent, and we do not employ, place, or refer candidates. We are not
            affiliated with, endorsed by, or acting as an agent of any job board, career site, or employer whose listings
            appear in the Service.
          </p>
          <p>
            Job listings are sourced from third parties and may be inaccurate, incomplete, out of date, filled, withdrawn, or
            in rare cases not genuine. We do not verify listings and do not guarantee their accuracy, availability, or
            legitimacy. You should verify any listing directly with its source before relying on it.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">5. AI Features &amp; Accuracy</h2>
          <p>
            Several parts of the Service — including relevance scoring, visa-sponsorship flagging, CV tailoring, cover-letter
            and email drafting, and the ATS match score — are generated by AI. AI output can be{' '}
            <strong className="text-text">inaccurate, incomplete, or misleading</strong>, and may occasionally produce content
            that is wrong even when it appears confident.
          </p>
          <p>You agree that:</p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>you are responsible for reviewing, correcting, and approving all AI-generated content before you use it,
              send it, or submit it to any employer or third party;</li>
            <li>relevance scores, visa-sponsorship flags, and ATS match scores are estimates only, not statements of fact
              about any job, employer, or applicant-tracking system; and</li>
            <li>you remain solely responsible for the content of every application you submit.</li>
          </ul>
          <p>
            JobTrackr does not guarantee that using the Service will result in interviews, job offers, employment, visa
            sponsorship or any visa outcome, or that any application will pass an applicant-tracking system. Nothing in the
            Service is migration advice, legal advice, or career advice.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">6. Bring-Your-Own-Key &amp; Third-Party AI Providers</h2>
          <p>
            Some AI features require you to supply your own API key for a third-party AI provider (currently Anthropic and/or
            OpenAI). If you use these features:
          </p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>you must have a valid account and API key with the relevant provider, obtained in accordance with that
              provider&apos;s terms;</li>
            <li>you are solely responsible for all usage, charges, and fees that the provider bills to your key, including
              usage generated through the Service;</li>
            <li>you must comply with the provider&apos;s terms of service, usage policies, and acceptable-use requirements
              at all times; and</li>
            <li>you may revoke or replace your key at any time via the provider or your JobTrackr settings.</li>
          </ul>
          <p>
            We store your API keys in encrypted form and use them only to provide the features you request. We are not
            responsible for the availability, performance, output, pricing, or policies of third-party AI providers, and we
            have no control over how they process requests sent using your key. See our{' '}
            <Link href="/privacy" className="text-brand hover:text-text transition-colors">Privacy Policy</Link> for more
            detail on how keys and related data are handled.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">7. Acceptable Use</h2>
          <p>You agree that you will not, and will not attempt to:</p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>scrape, crawl, harvest, or systematically extract data from the Service, or resell, republish, or
              redistribute content obtained through the Service;</li>
            <li>use the Service for any unlawful purpose or in breach of any applicable law or regulation;</li>
            <li>probe, scan, or test the vulnerability of the Service, circumvent authentication or security measures, or
              interfere with the Service&apos;s operation (including by overloading it or introducing malicious code);</li>
            <li>access the Service by automated means other than interfaces we expressly provide;</li>
            <li>submit another person&apos;s personal information or documents without the legal right and any necessary
              consent to do so;</li>
            <li>use the Service to create or submit CVs, cover letters, or applications containing information you know to
              be false or misleading — you are responsible for the truthfulness of your own CV and application content;</li>
            <li>impersonate any person or misrepresent your affiliation with any person or entity; or</li>
            <li>reverse engineer, decompile, or disassemble any part of the Service, except to the extent permitted by law.</li>
          </ul>
          <p>
            We may investigate suspected breaches of this section and may suspend or terminate accounts involved in them (see
            Section 15).
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">8. Your Content &amp; Licence to Us</h2>
          <p>
            You retain ownership of the content you provide to the Service, including your CV, work history, search
            preferences, and any documents or text you upload or enter (<strong className="text-text">Your Content</strong>).
          </p>
          <p>
            So that we can operate the Service, you grant JobTrackr a limited, non-exclusive, worldwide, royalty-free licence
            to host, store, reproduce, process, adapt, and display Your Content{' '}
            <strong className="text-text">solely for the purpose of providing and improving the Service to you</strong> — for
            example, extracting text from your uploaded CV, generating tailored CVs and cover letters, and calculating match
            scores. This licence ends when Your Content is deleted from the Service, subject to reasonable backup-retention
            periods described in our{' '}
            <Link href="/privacy" className="text-brand hover:text-text transition-colors">Privacy Policy</Link>.
          </p>
          <p>
            You warrant that you have all rights necessary to provide Your Content to us and that it does not infringe any
            third party&apos;s rights or any law.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">9. Intellectual Property</h2>
          <p>
            The Service — including its software, design, features, branding, logos, and trade marks — is owned by or licensed
            to JobTrackr and is protected by intellectual-property laws. Except for the limited right to use the Service in
            accordance with these Terms, nothing in these Terms transfers any intellectual-property rights to you.
          </p>
          <p>
            Job-listing content displayed in the Service belongs to its respective sources — the job boards, platforms, and
            employers that published it. All third-party names and trade marks (including SEEK, Adzuna, Careerjet, Greenhouse,
            and Lever) belong to their respective owners, and their appearance in the Service does not imply any affiliation
            or endorsement.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">10. Plans, Billing, Renewals &amp; Cancellation</h2>
          <p>
            JobTrackr offers a <strong className="text-text">free plan</strong>, available indefinitely, and paid subscription
            plans that unlock additional features such as more search profiles and higher scan frequency. Current plans and
            prices are shown in the Service at the time of purchase.
          </p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li><strong className="text-text">Payments.</strong> Paid plans are billed through our payment processor, Stripe.
              By subscribing, you authorise recurring charges to your nominated payment method. We do not store your full card
              details.</li>
            <li><strong className="text-text">Free trials.</strong> New customers may be offered a free trial. Unless you
              cancel before the trial ends, your subscription will begin and your payment method will be charged at the end of
              the trial period.</li>
            <li><strong className="text-text">Automatic renewal.</strong> Subscriptions renew automatically at the end of each
              billing period until cancelled.</li>
            <li><strong className="text-text">Cancellation.</strong> You can cancel at any time in your account settings.
              Cancellation takes effect at the end of the current billing period; you keep paid access until then. We do not
              provide pro-rata refunds for partial billing periods, except where required by law (including the Australian
              Consumer Law) or where we decide otherwise at our discretion.</li>
            <li><strong className="text-text">Price changes.</strong> We may change subscription prices with reasonable
              advance notice (for example, by email or in-app notice) before the change applies to your next renewal. If you
              do not accept a price change, you may cancel before it takes effect.</li>
            <li><strong className="text-text">Downgrades and taxes.</strong> If you downgrade or your subscription ends, some
              features and limits will revert to the free plan. Prices are stated inclusive or exclusive of GST as indicated
              at checkout.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">11. Australian Consumer Law</h2>
          <p>
            Our goods and services come with guarantees that cannot be excluded under the Australian Consumer Law
            (<strong className="text-text">ACL</strong>). Nothing in these Terms excludes, restricts, or modifies any consumer
            guarantee, right, or remedy conferred on you by the ACL or any other applicable law that cannot lawfully be
            excluded, restricted, or modified.
          </p>
          <p>
            Where our liability for breach of a non-excludable guarantee can lawfully be limited, and to the extent permitted
            by the ACL, our liability is limited, at our option, to:
          </p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>the resupply of the services, or the payment of the cost of having the services supplied again.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">12. Disclaimers</h2>
          <p>
            Subject to Section 11, the Service is provided on an <strong className="text-text">&quot;as is&quot;</strong> and{' '}
            <strong className="text-text">&quot;as available&quot;</strong> basis. To the maximum extent permitted by law, we
            do not warrant that:
          </p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>the Service will be uninterrupted, error-free, or secure, or that defects will be corrected;</li>
            <li>job listings sourced from third parties are accurate, complete, current, available, or genuine;</li>
            <li>AI-generated content — including scores, flags, and drafted documents — is accurate, complete, or fit for
              any particular purpose; or</li>
            <li>use of the Service will lead to any particular outcome, including interviews, offers, employment, or visa
              sponsorship.</li>
          </ul>
          <p className="text-text-3">
            Your dealings with employers, job boards, and third-party AI providers are between you and them. We are not a
            party to, and are not responsible for, those dealings.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">13. Limitation of Liability</h2>
          <p>
            This section applies subject to Section 11 (Australian Consumer Law) and only to the extent permitted by law.
          </p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>Neither party is liable to the other for any indirect, incidental, special, or consequential loss, or for
              loss of profits, revenue, opportunity, goodwill, or data, however arising, even if advised of the possibility of
              such loss.</li>
            <li>Our total aggregate liability to you for all claims arising out of or in connection with these Terms or the
              Service is capped at the greater of (a) the total fees you paid to us in the 12 months before the event giving
              rise to the claim, and (b) AUD 100. [Cap to be confirmed by lawyer.]</li>
          </ul>
          <p className="text-text-3">
            Without limiting the above, we are not liable for losses arising from third-party job listings, decisions made by
            employers, charges billed by your third-party AI provider, or your reliance on AI-generated content that you did
            not review before use.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">14. Indemnity</h2>
          <p>
            To the extent permitted by law, you indemnify JobTrackr and its officers, employees, and contractors against any
            loss, damage, liability, cost, or expense (including reasonable legal costs) arising out of or in connection with:
          </p>
          <ul className="list-disc list-inside space-y-1.5 text-text-2">
            <li>your breach of these Terms;</li>
            <li>your misuse of the Service or use of it in breach of any law;</li>
            <li>Your Content, including any claim that it infringes a third party&apos;s rights or contains false or
              unlawful material; or</li>
            <li>your submission of another person&apos;s personal information without the right to do so.</li>
          </ul>
          <p className="text-text-3">
            Your liability under this indemnity is reduced to the extent that our own acts or omissions contributed to the
            relevant loss.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">15. Suspension &amp; Termination</h2>
          <p>
            <strong className="text-text">By you.</strong> You may stop using the Service and close your account at any time
            via your account settings or by contacting us.
          </p>
          <p>
            <strong className="text-text">By us.</strong> We may suspend or terminate your access to all or part of the
            Service if you materially breach these Terms, if we reasonably suspect fraudulent or unlawful activity, if
            required by law, or if we discontinue the Service. Where practicable, we will give you reasonable notice and an
            opportunity to export Your Content before termination, except where the breach is serious or notice would be
            unlawful or impractical.
          </p>
          <p>
            On termination, your right to use the Service ends, and any unpaid fees for the period before termination remain
            payable. Deletion and retention of your personal information after account closure are handled in accordance with
            our <Link href="/privacy" className="text-brand hover:text-text transition-colors">Privacy Policy</Link>.
            Provisions that by their nature should survive termination — including Sections 8, 9, 11, 12, 13, 14, and 17 —
            survive.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">16. Changes to the Service &amp; These Terms</h2>
          <p>
            The Service will evolve. We may add, change, or remove features, and we may change the sources we aggregate
            listings from, at any time. If a change materially reduces the functionality of a paid plan during a period you
            have paid for, we will give you notice, and you may cancel and seek a pro-rata refund for the unused portion of
            that period.
          </p>
          <p>
            We may also update these Terms from time to time. If a change is material, we will give you reasonable advance
            notice — for example, by email or in-app notice — before it takes effect. Your continued use of the Service after
            the effective date of updated Terms constitutes acceptance of them. If you do not agree to updated Terms, you must
            stop using the Service and may close your account.
          </p>
          <p className="text-text-3">
            The current version of these Terms, including their effective date, will always be available on this page.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">17. Governing Law &amp; Jurisdiction</h2>
          <p>
            These Terms are governed by the laws of [State/Territory — e.g. New South Wales], Australia. You and we each
            submit to the non-exclusive jurisdiction of the courts of that state or territory and the courts entitled to hear
            appeals from them. This clause does not limit any rights you have under the Australian Consumer Law to bring
            proceedings in another forum.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-medium text-text">18. Contact</h2>
          <p>
            Questions about these Terms can be sent to{' '}
            <a href="mailto:privacy@jobtrackr.com.au" className="text-brand hover:text-text transition-colors">privacy@jobtrackr.com.au</a>.
            [A dedicated legal/support contact address may be added — to be confirmed.]
          </p>
          <p className="text-text-3">
            JobTrackr is operated by [Legal entity name / ABN — to be confirmed], Australia. Data is hosted in Sydney,
            Australia (ap-southeast-2).
          </p>
        </section>
      </article>
    </main>
  );
}
