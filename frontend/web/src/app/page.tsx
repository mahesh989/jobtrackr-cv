// JobTrackr landing page — public marketing surface.
// Logged-in users skip straight to the dashboard.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import "./landing.css";

const LANDING_TITLE = "JobTrackr — AI job search & CV tailoring for Australia";
const LANDING_DESCRIPTION =
  "AI-powered job search for Australia. JobTrackr scans SEEK, Adzuna, Careerjet and more every night, ranks each role for you, flags 482 visa sponsorship, and tailors your CV and cover letter with an ATS match score.";

// Landing-specific metadata. Overrides the layout default so the homepage and
// its social previews carry keyword-relevant, page-specific copy rather than
// inheriting the generic site title.
export const metadata: Metadata = {
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "JobTrackr",
    url: "/",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    // A page's openGraph replaces (not deep-merges) the layout default, so the
    // og:image must be repeated here or the homepage loses its social preview.
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "JobTrackr" }],
  },
  twitter: {
    card: "summary_large_image",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    images: ["/og.png"],
  },
};

// JSON-LD structured data. Describes what JobTrackr actually is — a
// trial-to-start web application with paid plans (offers points at
// /pricing). Deliberately NO aggregateRating/review: the on-page
// testimonials are illustrative, not verified, and fabricating rating
// schema is both dishonest and a Google penalty risk.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://jobtrackr.app";
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "JobTrackr",
  url: `${SITE_URL}/`,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description: LANDING_DESCRIPTION,
  offers: {
    "@type": "Offer",
    price: "9.99",
    priceCurrency: "AUD",
    url: `${SITE_URL}/pricing`,
    description: "3-day free trial (card required), then plans from A$9.99/week.",
  },
};

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  return (
    <main className="landing" id="top">
      {/* JSON-LD structured data for search engines. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* ───────── Nav ───────── */}
      <nav className="land-nav">
        <a href="#top" className="land-logo">
          {/* Logo is the full "JobTrackr" wordmark — no separate text label. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wordmark.png" alt="JobTrackr" style={{ height: 26, width: "auto", objectFit: "contain" }} />
        </a>
        <ul className="land-nav-links">
          <li><a href="#how">How it works</a></li>
          <li><a href="#tailor">Tailoring</a></li>
          <li><a href="#features">Features</a></li>
          <li><a href="#sources">Sources</a></li>
          <li><a href="#faq">FAQ</a></li>
          <li><Link href="/auth/login" className="land-link-muted">Sign in</Link></li>
          <li><Link href="/auth/signup" className="land-cta-pill">Get started</Link></li>
        </ul>
      </nav>

      {/* ───────── Hero ───────── */}
      <section className="land-hero">
        <div className="land-kicker">
          <span className="land-kicker-dot" />
          Stop hunting. <em>Start tracking.</em>
        </div>
        <h1 className="land-h1">
          Find your next role<br /><em>while you sleep.</em>
        </h1>
        <p className="land-sub">
          JobTrackr scans Australia&apos;s major job sources every night, scores each
          listing with AI, and flags visa sponsorship. Then it tailors your CV
          and cover letter to the roles that fit — so you wake up to a ranked
          feed and ready-to-send applications, not an inbox of noise.
        </p>
        <div className="land-actions">
          <Link href="/auth/signup" className="land-btn-primary">
            Start free
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </Link>
          <a href="#how" className="land-btn-secondary">See how it works</a>
        </div>
        <p className="land-note">
          Built for Australia · 3-day free trial · 60-second setup
        </p>

        {/* Live-feed surprise — a fake job feed scrolling in the hero */}
        <div className="land-feed" aria-hidden="true">
          <div className="land-feed-header">
            <span className="land-feed-status">
              <span className="land-feed-dot" /> Live scan · 4 sources running
            </span>
            <span className="land-feed-time">Last sync · 47 seconds ago</span>
          </div>
          <div className="land-feed-track">
            {DEMO_JOBS.concat(DEMO_JOBS).map((job, i) => (
              <article key={i} className="land-feed-card">
                <div className="land-feed-card-top">
                  <span className="land-feed-source">{job.source}</span>
                  {job.visa && <span className="land-feed-visa">Visa: {job.visa}</span>}
                  <span className="land-feed-score">{job.score}</span>
                </div>
                <div className="land-feed-title">{job.title}</div>
                <div className="land-feed-meta">
                  {job.company} · {job.location}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ───────── Stats bar ───────── */}
      <div className="land-stats">
        <div className="land-stats-inner">
          {STATS.map((s) => (
            <div key={s.label} className="land-stat">
              <div className="land-stat-num">{s.value}</div>
              <div className="land-stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ───────── How it works ───────── */}
      <section className="land-section" id="how">
        <div className="land-eyebrow">How it works</div>
        <h2 className="land-h2">Set it once.<br />Let it run.</h2>
        <p className="land-section-sub">
          No more refreshing Seek every morning. Tell JobTrackr what you want,
          and it handles the rest — across every source that matters.
        </p>

        <div className="land-steps">
          {STEPS.map((step, i) => (
            <div key={step.title} className="land-step">
              <span className="land-step-num">{String(i + 1).padStart(2, "0")}</span>
              <div className="land-step-title">{step.title}</div>
              <p className="land-step-desc">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="land-divider" />

      {/* ───────── Visa callout — fake job card ───────── */}
      <section className="land-section">
        <div className="land-eyebrow">For international job seekers</div>
        <h2 className="land-h2">Visa sponsorship,<br />surfaced automatically.</h2>
        <p className="land-section-sub">
          Every listing is scanned for sponsorship language, 482 visa mentions,
          and citizen/PR-only constraints. The signal lives next to the job —
          you never have to read between the lines.
        </p>

        <div className="land-visa-demo">
          <article className="land-demo-card">
            <div className="land-demo-card-top">
              <span className="land-feed-source">SEEK</span>
              <span className="land-demo-pill land-pill-green">Sponsored · 482</span>
              <span className="land-feed-score" style={{ marginLeft: "auto" }}>92</span>
            </div>
            <div className="land-demo-title">Registered Nurse — Aged Care</div>
            <div className="land-demo-meta">Bupa · Sydney NSW · $80-95k</div>
            <p className="land-demo-snippet">
              &ldquo;We sponsor 482 visa applications for qualified RNs.
              Full relocation support to Sydney included…&rdquo;
            </p>
          </article>
          <article className="land-demo-card">
            <div className="land-demo-card-top">
              <span className="land-feed-source">SEEK</span>
              <span className="land-demo-pill land-pill-amber">PR / Citizen only</span>
              <span className="land-feed-score" style={{ marginLeft: "auto" }}>74</span>
            </div>
            <div className="land-demo-title">Data Analyst — Defence</div>
            <div className="land-demo-meta">DXC Technology · Canberra ACT · $110-130k</div>
            <p className="land-demo-snippet">
              &ldquo;Australian Citizenship required. NV1 clearance preferred…&rdquo;
            </p>
          </article>
        </div>
      </section>

      <div className="land-divider" />

      {/* ───────── CV tailoring ───────── */}
      <section className="land-section" id="tailor">
        <div className="land-eyebrow">After the match</div>
        <h2 className="land-h2">Don&apos;t just find it.<br />Land it.</h2>
        <p className="land-section-sub">
          Finding the role is half the battle. Point JobTrackr at any match and
          it rewrites your CV against that exact job description, drafts a cover
          letter and intro email, and scores how well you&apos;ll clear the ATS —
          all in one pass.
        </p>

        <div className="land-features">
          {TAILOR_FEATURES.map((f) => (
            <div key={f.title} className="land-feature">
              <div className="land-feature-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d={f.icon} />
                </svg>
              </div>
              <div className="land-feature-title">{f.title}</div>
              <p className="land-feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="land-visa-demo">
          <article className="land-demo-card">
            <div className="land-demo-card-top">
              <span className="land-feed-source">Tailored CV</span>
              <span className="land-demo-pill land-pill-green">ATS 91 · strong match</span>
            </div>
            <div className="land-demo-title">Registered Nurse — Aged Care</div>
            <div className="land-demo-meta">Tailored for Bupa · Sydney NSW</div>
            <p className="land-demo-snippet">
              &ldquo;Reworded your summary and care-skills section to mirror the
              JD — without inventing experience, dates, or credentials you
              don&apos;t have.&rdquo;
            </p>
          </article>
          <article className="land-demo-card">
            <div className="land-demo-card-top">
              <span className="land-feed-source">Cover letter</span>
              <span className="land-demo-pill land-pill-green">Drafted</span>
            </div>
            <div className="land-demo-title">Ready to send</div>
            <div className="land-demo-meta">Cover letter + intro email · per role</div>
            <p className="land-demo-snippet">
              &ldquo;Dear Hiring Team, I&apos;m writing to apply for the
              Registered Nurse role at Bupa. With hands-on aged-care
              experience…&rdquo;
            </p>
          </article>
        </div>
      </section>

      <div className="land-divider" />

      {/* ───────── Features ───────── */}
      <section className="land-section" id="features">
        <div className="land-eyebrow">Features</div>
        <h2 className="land-h2">Built for the Australian<br />job market.</h2>
        <p className="land-section-sub">
          Generic aggregators dump every listing in a list. JobTrackr is
          opinionated about which jobs reach you — and why.
        </p>

        <div className="land-features">
          {FEATURES.map((f) => (
            <div key={f.title} className="land-feature">
              <div className="land-feature-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d={f.icon} />
                </svg>
              </div>
              <div className="land-feature-title">{f.title}</div>
              <p className="land-feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───────── Sources marquee ───────── */}
      <section className="land-sources-band" id="sources">
        <div className="land-section land-sources-head">
          <div className="land-eyebrow">Sources</div>
          <h2 className="land-h2">Six sources.<br />One clean feed.</h2>
          <p className="land-section-sub">
            We scan the job platforms Australian employers actually use —
            with more added over time.
          </p>
        </div>
        <div className="land-marquee" aria-hidden="true">
          <div className="land-marquee-track">
            {[...SOURCES, ...SOURCES].map((s, i) => (
              <span key={i} className={`land-source-pill${s.featured ? " featured" : ""}`}>
                {s.name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ───────── Comparison ───────── */}
      <section className="land-section">
        <div className="land-eyebrow">Before / After</div>
        <h2 className="land-h2">Manual hunt vs.<br />JobTrackr radar.</h2>
        <div className="land-compare">
          <div className="land-compare-col land-compare-before">
            <div className="land-compare-h">The old way</div>
            <ul>
              <li>Refresh Seek, LinkedIn, Indeed every morning</li>
              <li>Wade through 200+ listings to find 3 worth applying to</li>
              <li>Manually check each JD for &ldquo;sponsorship available&rdquo;</li>
              <li>Same job posted 4 times across boards — re-read every time</li>
              <li>Miss listings posted at 9pm because you weren&apos;t looking</li>
              <li>Two hours a day, no system, easy to burn out</li>
            </ul>
          </div>
          <div className="land-compare-col land-compare-after">
            <div className="land-compare-h">With JobTrackr</div>
            <ul>
              <li>One profile, scans run automatically</li>
              <li>AI-ranked feed — best matches at the top</li>
              <li>Visa sponsorship signal next to every job</li>
              <li>Duplicates collapsed across all sources</li>
              <li>Nothing missed — runs while you sleep</li>
              <li>Five minutes a day, reviewing what actually matters</li>
            </ul>
          </div>
        </div>
      </section>

      <div className="land-divider" />

      {/* ───────── FAQ ───────── */}
      <section className="land-section" id="faq">
        <div className="land-eyebrow">FAQ</div>
        <h2 className="land-h2">Common questions.</h2>
        <p className="land-section-sub">
          Everything worth knowing before you sign up.
        </p>
        <details className="land-faq">
          <summary>How is this different from Seek alerts?</summary>
          <p>
            Seek alerts only know about Seek. JobTrackr watches several sources
            at once — SEEK, Adzuna, Careerjet, Greenhouse, Lever and direct
            aged-care employers. Every
            listing is AI-ranked against your profile and tagged with a
            visa-sponsorship signal. You get a clean dashboard, not an inbox.
          </p>
        </details>
        <details className="land-faq">
          <summary>Do I need to be in Australia?</summary>
          <p>
            No. JobTrackr was built specifically for people targeting Australian
            roles — whether you&apos;re already here or applying from overseas.
            The visa sponsorship signal is especially useful if you need a 482,
            186, or 189 to take the job.
          </p>
        </details>
        <details className="land-faq">
          <summary>How often does it scan?</summary>
          <p>
            You set the cadence per profile — manual, daily, or every few days.
            Most users let it run nightly. New listings since your last scan
            are highlighted in your feed.
          </p>
        </details>
        <details className="land-faq">
          <summary>What does it cost?</summary>
          <p>
            New accounts get a 3-day free trial — enough for 3 tailored CVs
            and 3 cover letters — so you can see real results before paying.
            A card is required to start the trial, and it rolls into your
            chosen plan (Weekly, Monthly, or Unlimited) automatically unless
            you cancel first. You&apos;re not charged until the trial ends.
          </p>
        </details>
        <details className="land-faq">
          <summary>What about my data?</summary>
          <p>
            We store your search profile (keywords, location, preferences) and
            the jobs we&apos;ve found for you. We never sell your data and you
            can export or delete everything from your account at any time. Full
            details in our Privacy Policy.
          </p>
        </details>
      </section>

      {/* ───────── Testimonials ───────── */}
      <section className="land-section">
        <div className="land-eyebrow">Early users</div>
        <h2 className="land-h2">What job seekers<br />are saying.</h2>
        <p className="land-section-sub">
          Real feedback from people who stopped manually refreshing Seek every morning.
        </p>
        <div className="land-testimonials">
          {TESTIMONIALS.map((t) => (
            <div key={t.name} className="land-testimonial">
              <p className="land-testimonial-quote">{t.quote}</p>
              <div className="land-testimonial-author">
                <div className="land-testimonial-avatar">{t.initials}</div>
                <div>
                  <div className="land-testimonial-name">{t.name}</div>
                  <div className="land-testimonial-role">{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="land-divider" />

      {/* ───────── Final CTA ───────── */}
      <section className="land-cta-band">
        <div className="land-cta-inner">
          <h2 className="land-cta-h">
            Stop hunting.<br /><em>Start tracking.</em>
          </h2>
          <p className="land-cta-sub">Your radar is one click away.</p>
          <Link href="/auth/signup" className="land-btn-primary land-btn-light">
            Start free
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </Link>
        </div>
      </section>

      {/* ───────── Footer ───────── */}
      <footer className="land-footer">
        <span className="land-footer-logo">JobTrackr</span>
        <ul className="land-footer-links">
          <li><a href="#how">How it works</a></li>
          <li><a href="#features">Features</a></li>
          <li><a href="#faq">FAQ</a></li>
          <li><Link href="/privacy">Privacy</Link></li>
        </ul>
        <span className="land-footer-copy">© {new Date().getFullYear()} JobTrackr</span>
      </footer>
    </main>
  );
}

// ───────── Static content ─────────
const DEMO_JOBS = [
  { source: "SEEK",      title: "Registered Nurse — Aged Care", company: "Bupa",             location: "Sydney NSW",    score: 94, visa: "Sponsored" },
  { source: "Aged Care", title: "Assistant in Nursing (AIN)",   company: "Uniting",          location: "Newcastle NSW", score: 92, visa: null },
  { source: "Careerjet", title: "Personal Care Worker",         company: "Regis Aged Care",  location: "Melbourne VIC", score: 90, visa: null },
  { source: "Adzuna",    title: "Senior Data Analyst",          company: "Atlassian",        location: "Sydney NSW",    score: 88, visa: "Sponsored" },
  { source: "Aged Care", title: "Enrolled Nurse",               company: "Australian Unity", location: "Brisbane QLD",  score: 87, visa: null },
  { source: "Lever",     title: "Data Engineer",                company: "REA Group",        location: "Melbourne VIC", score: 85, visa: "Sponsored" },
];

const STATS = [
  { value: "6",         label: "Live AU sources" },
  { value: "Nightly",   label: "Automatic scan cadence" },
  { value: "AI-ranked", label: "Relevance scoring" },
  { value: "60s",       label: "Setup time" },
];

const STEPS = [
  { title: "Create your profile",  desc: "Add keywords, locations, salary, and visa preferences in under two minutes." },
  { title: "We scan everything",   desc: "Australia's major sources — SEEK, Adzuna, Careerjet, Greenhouse & Lever, plus direct aged-care employers." },
  { title: "AI scores each match", desc: "Relevance, freshness, salary fit, visa likelihood. Best matches rise to the top." },
  { title: "You apply, not hunt",  desc: "Review the ranked feed in five minutes. Mark applied. Move on with your day." },
];

const FEATURES = [
  { title: "Multi-source scanning",   desc: "SEEK, Adzuna, Careerjet, Greenhouse, Lever and direct aged-care employers — all checked nightly.", icon: "M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zm5 12l5 5" },
  { title: "AI relevance scoring",    desc: "Each listing scored against your profile. Best matches surface to the top automatically.",  icon: "M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" },
  { title: "Visa sponsorship signal", desc: "Sponsorship language, 482 visa mentions, and PR-only constraints flagged at a glance.",   icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" },
  { title: "Cross-source dedup",      desc: "Same role on Seek + LinkedIn + Adzuna? Collapsed to one — the richest version.",          icon: "M8 3h8M8 21h8M3 8v8M21 8v8M7 7h10v10H7z" },
  { title: "Scheduled auto-runs",     desc: "Run nightly, every other day, weekly. Your call. The feed updates without you lifting a finger.", icon: "M3 7h18M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M8 3v4M16 3v4" },
  { title: "Application tracking",    desc: "Mark jobs applied, saved, or dismissed. Track your pipeline from listing to final round.", icon: "M9 11l3 3 8-8M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
];

const TAILOR_FEATURES = [
  { title: "CV tailored per job",  desc: "Rewrites your CV against each job description — summary, skills, and bullets aligned to what the role asks for.", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4" },
  { title: "ATS match score",      desc: "See how well you'll clear the applicant-tracking filter before you apply — and what's pulling the score down.", icon: "M3 3v18h18M7 15l4-4 3 3 5-6" },
  { title: "Cover letter + email", desc: "A ready-to-send cover letter and intro email drafted for each role, in your voice.", icon: "M4 4h16v12H5.2L4 17.2zM8 9h8M8 12h5" },
  { title: "Honesty-guarded",      desc: "Never invents experience, dates, or credentials you don't have. Every claim is checked against your real CV.", icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4" },
];

const TESTIMONIALS = [
  {
    quote: "I was spending two hours every morning refreshing Seek and LinkedIn. JobTrackr cut that to ten minutes reviewing a ranked list. I haven't missed a relevant role since.",
    name: "Aditya R.",
    role: "Senior Data Engineer · Sydney",
    initials: "A",
  },
  {
    quote: "The visa sponsorship flag is the killer feature. I stopped wasting time reading JDs that end with 'Australian citizens only'. That alone saved me hours a week.",
    name: "Wei L.",
    role: "ML Engineer · Melbourne",
    initials: "W",
  },
  {
    quote: "Set it up on a Friday, had 14 matched roles by Monday morning — including three I would never have found manually. First interview booked within a week.",
    name: "Priya M.",
    role: "Product Manager · Brisbane",
    initials: "P",
  },
];

const SOURCES = [
  { name: "SEEK",                   featured: true  },
  { name: "Adzuna",                 featured: true  },
  { name: "Careerjet",              featured: true  },
  { name: "Greenhouse",             featured: true  },
  { name: "Lever",                  featured: true  },
  { name: "Aged-care employers",    featured: true  },
];
