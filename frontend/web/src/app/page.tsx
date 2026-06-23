// JobTrackr landing page — public marketing surface.
// Logged-in users skip straight to the dashboard.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import "./landing.css";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  return (
    <main className="landing" id="top">
      {/* ───────── Nav ───────── */}
      <nav className="land-nav">
        <a href="#top" className="land-logo">
          <span className="land-logo-mark" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" style={{ width: 20, height: 20, objectFit: "contain" }} />
          </span>
          <span className="land-logo-text">JobTrackr</span>
        </a>
        <ul className="land-nav-links">
          <li><a href="#how">How it works</a></li>
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
          listing with AI, flags visa sponsorship, and surfaces only what
          actually matches you. Wake up to a ranked feed — not an inbox of noise.
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
          Built for Australia · Free plan available · 60-second setup
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
            <div className="land-demo-title">Senior Data Engineer</div>
            <div className="land-demo-meta">Atlassian · Sydney NSW · $160-185k</div>
            <p className="land-demo-snippet">
              &ldquo;We sponsor 482 visa applications for the right candidate.
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
          <h2 className="land-h2">Five sources.<br />One clean feed.</h2>
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
            at once — SEEK, Adzuna, Careerjet, Greenhouse and Lever. Every
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
            There&apos;s a free plan you can use indefinitely. Paid plans
            unlock more profiles, higher scan frequency, and priority compute.
            No credit card needed to start.
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
  { source: "SEEK",      title: "Senior Data Analyst",       company: "Atlassian",         location: "Sydney NSW",    score: 94, visa: "Sponsored" },
  { source: "Careerjet", title: "ML Engineer",                company: "Canva",             location: "Sydney NSW",    score: 91, visa: "Sponsored" },
  { source: "Adzuna",    title: "Analytics Manager",          company: "Commonwealth Bank", location: "Sydney CBD",    score: 88, visa: null },
  { source: "Lever",     title: "Data Engineer",              company: "REA Group",         location: "Melbourne VIC", score: 86, visa: "Sponsored" },
  { source: "SEEK",      title: "Business Intelligence Lead", company: "Telstra",           location: "Sydney NSW",    score: 84, visa: null },
  { source: "Greenhouse",title: "Senior Data Engineer",       company: "Stripe",            location: "Remote AU",     score: 82, visa: "Sponsored" },
];

const STATS = [
  { value: "5",         label: "Live AU sources" },
  { value: "Nightly",   label: "Automatic scan cadence" },
  { value: "AI-ranked", label: "Relevance scoring" },
  { value: "60s",       label: "Setup time" },
];

const STEPS = [
  { title: "Create your profile",  desc: "Add keywords, locations, salary, and visa preferences in under two minutes." },
  { title: "We scan everything",   desc: "Australia's major sources — SEEK, Adzuna, Careerjet, plus Greenhouse & Lever ATS feeds." },
  { title: "AI scores each match", desc: "Relevance, freshness, salary fit, visa likelihood. Best matches rise to the top." },
  { title: "You apply, not hunt",  desc: "Review the ranked feed in five minutes. Mark applied. Move on with your day." },
];

const FEATURES = [
  { title: "Multi-source scanning",   desc: "SEEK, Adzuna, Careerjet, Greenhouse and Lever — all checked nightly.", icon: "M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zm5 12l5 5" },
  { title: "AI relevance scoring",    desc: "Each listing scored against your profile. Best matches surface to the top automatically.",  icon: "M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" },
  { title: "Visa sponsorship signal", desc: "Sponsorship language, 482 visa mentions, and PR-only constraints flagged at a glance.",   icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" },
  { title: "Cross-source dedup",      desc: "Same role on Seek + LinkedIn + Adzuna? Collapsed to one — the richest version.",          icon: "M8 3h8M8 21h8M3 8v8M21 8v8M7 7h10v10H7z" },
  { title: "Scheduled auto-runs",     desc: "Run nightly, every other day, weekly. Your call. The feed updates without you lifting a finger.", icon: "M3 7h18M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M8 3v4M16 3v4" },
  { title: "Application tracking",    desc: "Mark jobs applied, saved, or dismissed. Track your pipeline from listing to final round.", icon: "M9 11l3 3 8-8M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" },
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
  { name: "SEEK",       featured: true  },
  { name: "Adzuna",     featured: true  },
  { name: "Careerjet",  featured: true  },
  { name: "Greenhouse", featured: true  },
  { name: "Lever",      featured: true  },
];
