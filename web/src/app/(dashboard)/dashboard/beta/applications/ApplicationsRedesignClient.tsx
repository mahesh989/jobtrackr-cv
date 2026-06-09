"use client";

/**
 * Applications redesign — interactive mock.
 *
 * Two ideas being previewed:
 *   1. Application pool is the triage gate. Compact rows that EXPAND in place
 *      to quick-peek the cover letter + tailored CV, so the go/no-go decision
 *      needs no navigation. Move forward (+ optional contact email) or Dismiss.
 *   2. "Ready to send" is the BIG CARD — the modal's contents pulled inline.
 *      Sectioned preview (Cover letter / Tailored CV / Email message), inline
 *      editable subject + body, a channel chip, and ONE channel-adaptive
 *      primary action: Send email (has email) OR Copy email + Apply now (no
 *      email). Secondary actions live behind a ··· menu.
 *
 * Everything is local state — no network. The point is to feel the flow.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Inbox, Send, Archive, ChevronDown, ChevronRight, Mail, ExternalLink,
  FileText, FileType, Copy, Check, CheckCircle2, Pencil, MoreHorizontal,
  Download, Sparkles,
} from "lucide-react";

// ── types & mock data ──────────────────────────────────────────────────────

type Stage = "pool" | "send" | "sent" | "archived";

interface MockApp {
  id: string;
  title: string;
  company: string;
  location: string;
  source: string;
  score: number;
  stage: Stage;
  contactEmail: string | null;
  letterAgo: string;
  coverLetter: string;
  cvSummary: string;
  emailSubject: string;
  emailBody: string;
  voiceRewritten: boolean;
}

const SAMPLE_COVER = `Dear Hiring Manager,

I am writing to express my strong interest in the Personal Care Assistant role at 365 Care in Penrith. With over four years supporting clients in residential aged care and home-based settings, I bring hands-on experience in personal care, medication assistance, and dementia-informed support.

In my current role I deliver person-centred care to a caseload of 12 clients, documenting via BESTMed and coordinating closely with RNs on changing care plans. I hold a current First Aid certificate, NDIS Worker Screening Check, and a valid driver's licence.

I would welcome the opportunity to bring my warmth and reliability to your home-care team.

Kind regards,
Maria Santos`;

const SAMPLE_CV = `Care Skills: Personal care · Medication assistance · Dementia care · Manual handling · Mobility support · Continence care
Experience: Personal Care Assistant — Bolton Clarke (2022–present) · AIN — Anglicare (2020–2022)
Credentials: Cert III Individual Support · First Aid · NDIS Worker Screening · Driver's licence (Full Time work rights)`;

const APPS: MockApp[] = [
  {
    id: "a1",
    title: "Personal Care Assistant — Home Care | Penrith",
    company: "365 Care", location: "Penrith, Sydney NSW", source: "AIN Sydney",
    score: 81, stage: "pool", contactEmail: null, letterAgo: "today",
    coverLetter: SAMPLE_COVER, cvSummary: SAMPLE_CV,
    emailSubject: "Application for Personal Care Assistant — Penrith Home Care",
    emailBody: "Dear Hiring Manager,\n\nPlease find attached my CV and cover letter for the Personal Care Assistant role in Penrith. I have 4+ years in aged and home care and would love to discuss how I can support your clients.\n\nKind regards,\nMaria Santos",
    voiceRewritten: true,
  },
  {
    id: "a2",
    title: "Aged Care Worker — Residential",
    company: "Bolton Clarke", location: "Chatswood NSW", source: "Aged Care NSW",
    score: 88, stage: "pool", contactEmail: null, letterAgo: "today",
    coverLetter: SAMPLE_COVER, cvSummary: SAMPLE_CV,
    emailSubject: "Application for Aged Care Worker — Chatswood",
    emailBody: "Dear Hiring Manager,\n\nI'm applying for the Aged Care Worker role at Bolton Clarke. My CV and cover letter are attached.\n\nKind regards,\nMaria Santos",
    voiceRewritten: false,
  },
  {
    id: "a3",
    title: "Disability Support Worker",
    company: "Anglicare", location: "Parramatta NSW", source: "AIN Sydney",
    score: 74, stage: "send", contactEmail: "careers@anglicare.org.au", letterAgo: "1d ago",
    coverLetter: SAMPLE_COVER, cvSummary: SAMPLE_CV,
    emailSubject: "Application for Disability Support Worker — Parramatta",
    emailBody: "Dear Hiring Team,\n\nI'd like to apply for the Disability Support Worker position. Please find my tailored CV and cover letter attached. I bring NDIS experience and a current Worker Screening Check.\n\nKind regards,\nMaria Santos",
    voiceRewritten: true,
  },
  {
    id: "a4",
    title: "Home Care Assistant — Community",
    company: "Uniting", location: "Hurstville NSW", source: "Aged Care NSW",
    score: 79, stage: "send", contactEmail: null, letterAgo: "2d ago",
    coverLetter: SAMPLE_COVER, cvSummary: SAMPLE_CV,
    emailSubject: "Application for Home Care Assistant — Hurstville",
    emailBody: "Dear Hiring Manager,\n\nI'm writing to apply for the Home Care Assistant role in Hurstville. My CV and cover letter are attached for your review.\n\nKind regards,\nMaria Santos",
    voiceRewritten: false,
  },
  {
    id: "a5",
    title: "Personal Care Worker — Night Shift",
    company: "Opal HealthCare", location: "Killara NSW", source: "Aged Care NSW",
    score: 83, stage: "sent", contactEmail: "recruit@opal.com.au", letterAgo: "3d ago",
    coverLetter: SAMPLE_COVER, cvSummary: SAMPLE_CV,
    emailSubject: "Application for Personal Care Worker — Night Shift",
    emailBody: "...", voiceRewritten: true,
  },
  {
    id: "a6",
    title: "Cleaner — Aged Care Facility",
    company: "Spotless", location: "Bankstown NSW", source: "Cleaning NSW",
    score: 51, stage: "archived", contactEmail: null, letterAgo: "5d ago",
    coverLetter: SAMPLE_COVER, cvSummary: SAMPLE_CV,
    emailSubject: "Application for Cleaner role", emailBody: "...", voiceRewritten: false,
  },
];

const TABS: Array<{ key: Stage; label: string }> = [
  { key: "pool",     label: "Application pool" },
  { key: "send",     label: "Ready to send" },
  { key: "sent",     label: "Sent / Applied" },
  { key: "archived", label: "Archived" },
];

const TAB_HELP: Record<Stage, string> = {
  pool:     "First look after an analysis run. Expand a card to skim the cover letter and tailored CV, then move it forward (add a contact email if you found one in the ad) or dismiss it.",
  send:     "Everything you need on one card: review and tweak the email, then send. Cards with a contact email send in one click; cards without one let you copy the message and apply via the job link.",
  sent:     "Jobs you've applied to. Track outcomes here.",
  archived: "Jobs you dismissed after a cover letter was generated.",
};

function scoreColor(n: number) {
  if (n >= 75) return "text-emerald-600";
  if (n >= 55) return "text-amber-600";
  return "text-red-600";
}

// ── component ───────────────────────────────────────────────────────────────

export function ApplicationsRedesignClient() {
  const [apps, setApps] = useState<MockApp[]>(APPS);
  const [tab, setTab]   = useState<Stage>("pool");

  const counts = useMemo(() => ({
    pool:     apps.filter((a) => a.stage === "pool").length,
    send:     apps.filter((a) => a.stage === "send").length,
    sent:     apps.filter((a) => a.stage === "sent").length,
    archived: apps.filter((a) => a.stage === "archived").length,
  }), [apps]);

  const visible = apps.filter((a) => a.stage === tab);

  function move(id: string, stage: Stage) {
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, stage } : a)));
  }
  function setEmail(id: string, email: string | null) {
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, contactEmail: email } : a)));
  }
  function patch(id: string, p: Partial<MockApp>) {
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, ...p } : a)));
  }

  return (
    <div className="min-h-full">
      {/* Header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-text-2">Beta · Applications redesign</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Applications</h1>
        <p className="text-[12px] text-text-2 mt-0.5">
          {apps.length} jobs with a completed cover letter ·{" "}
          <span className="text-[var(--brand)]">preview of the simplified 4-stage flow</span>
        </p>
      </div>

      <div className="px-6 py-5 space-y-4 max-w-4xl">
        {/* Tabs */}
        <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-0.5 w-fit">
          {TABS.map((t) => {
            const active = tab === t.key;
            const count = counts[t.key];
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all whitespace-nowrap ${
                  active ? "bg-[var(--surface)] text-text shadow-sm border border-[var(--border)]" : "text-text-2 hover:text-text"
                }`}
              >
                {t.label}
                {count > 0 && (
                  <span className={"text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center " +
                    (active ? "bg-text text-[var(--surface)]" : "bg-[var(--border)] text-text-2")}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <p className="text-[12px] text-text-2">{TAB_HELP[tab]}</p>

        {/* List */}
        {visible.length === 0 ? (
          <div className="bg-surface border border-border rounded-md py-12 text-center">
            <Inbox className="w-7 h-7 text-text-3 mx-auto mb-2" />
            <p className="text-[13px] font-medium text-text mb-1">Nothing here yet</p>
            <p className="text-[12px] text-text-2">Cards in this stage will appear here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((a) =>
              a.stage === "pool" ? (
                <PoolCard key={a.id} app={a} onMove={move} onSetEmail={setEmail} />
              ) : a.stage === "send" ? (
                <SendCard key={a.id} app={a} onMove={move} onSetEmail={setEmail} onPatch={patch} />
              ) : (
                <DoneCard key={a.id} app={a} onMove={move} />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pool card — compact, expands in place for quick-peek ─────────────────────

function PoolCard({ app, onMove, onSetEmail }: {
  app: MockApp; onMove: (id: string, s: Stage) => void; onSetEmail: (id: string, e: string | null) => void;
}) {
  const [open, setOpen]   = useState(false);
  const [peek, setPeek]   = useState<"cover" | "cv">("cover");
  const [email, setEmail] = useState("");

  return (
    <div className="bg-surface border border-border rounded-md anim-in hover:border-[var(--text-3)] transition-colors">
      {/* Summary row */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-text-3 shrink-0" /> : <ChevronRight className="w-4 h-4 text-text-3 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-text truncate">{app.title}</p>
          <p className="text-[12px] text-text-2 truncate mt-0.5">
            {app.company} · {app.location} · via {app.source}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] uppercase tracking-wider text-text-3">Tailored</p>
          <p className={`text-[18px] font-bold tabular-nums ${scoreColor(app.score)}`}>
            {app.score}<span className="text-[11px] text-text-3 font-medium">/100</span>
          </p>
        </div>
      </button>

      {/* Expanded quick-peek */}
      {open && (
        <div className="px-4 pb-4 border-t border-border pt-3">
          {/* peek toggle */}
          <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded p-0.5 w-fit mb-2">
            {([["cover", "Cover letter", FileType], ["cv", "Tailored CV", FileText]] as const).map(([k, label, Icon]) => (
              <button
                key={k}
                onClick={() => setPeek(k)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                  peek === k ? "bg-[var(--surface)] text-text shadow-sm" : "text-text-2 hover:text-text"
                }`}
              >
                <Icon className="w-3 h-3" /> {label}
              </button>
            ))}
          </div>
          <pre className="text-[12px] leading-relaxed text-text-2 whitespace-pre-wrap font-sans bg-[var(--surface-2)] border border-border rounded p-3 max-h-52 overflow-y-auto">
            {peek === "cover" ? app.coverLetter : app.cvSummary}
          </pre>

          {/* Decision row */}
          <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <p className="text-[13px] font-semibold text-text mb-2">Want to pursue this one?</p>
            <div className="flex items-center gap-2">
              <input
                type="email"
                placeholder="Contact email from the ad (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1 text-[12px] px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
              />
              <button
                onClick={() => { onSetEmail(app.id, email.trim() || null); onMove(app.id, "send"); }}
                className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1.5 shrink-0"
              >
                <Send className="w-3 h-3" /> Move forward
              </button>
            </div>
            <p className="text-[11px] text-text-2 mt-1.5">
              Found an email in the ad? Add it for one-click send. Leave blank to copy the message and apply via the job link.
            </p>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <a href="#" className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1">
              <FileText className="w-3 h-3" /> Full analysis
            </a>
            <button
              onClick={() => onMove(app.id, "archived")}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors ml-auto"
            >
              <Archive className="w-3 h-3" /> Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Send card — the BIG card. Review + send in one place ─────────────────────

function SendCard({ app, onMove, onSetEmail, onPatch }: {
  app: MockApp;
  onMove: (id: string, s: Stage) => void;
  onSetEmail: (id: string, e: string | null) => void;
  onPatch: (id: string, p: Partial<MockApp>) => void;
}) {
  const [section, setSection] = useState<"email" | "cover" | "cv">("email");
  const [copied, setCopied]   = useState(false);
  const [menu, setMenu]       = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft]     = useState(app.contactEmail ?? "");

  const hasEmail = !!app.contactEmail;

  function copyMessage() {
    const payload = `Subject: ${app.emailSubject}\n\n${app.emailBody}`;
    navigator.clipboard?.writeText(payload).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="bg-surface border border-border rounded-md anim-in">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <a href="#" className="text-[14px] font-semibold text-text hover:text-[var(--brand)] transition-colors">{app.title}</a>
              <ExternalLink className="w-3 h-3 text-text-3 shrink-0" />
            </div>
            <p className="text-[12px] text-text-2 truncate mt-0.5">{app.company} · {app.location} · via {app.source}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] uppercase tracking-wider text-text-3">Tailored</p>
            <p className={`text-[18px] font-bold tabular-nums ${scoreColor(app.score)}`}>
              {app.score}<span className="text-[11px] text-text-3 font-medium">/100</span>
            </p>
          </div>
        </div>

        {/* Channel chip */}
        <div className="mt-2 flex items-center gap-2 flex-wrap text-[12px]">
          {hasEmail ? (
            <span className="inline-flex items-center gap-1.5 text-text-2">
              <Mail className="w-3.5 h-3.5 text-[var(--brand)]" />
              <span className="font-medium">To:</span>
              {editingEmail ? (
                <input
                  autoFocus type="email" value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  onBlur={() => { onSetEmail(app.id, emailDraft.trim() || null); setEditingEmail(false); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { onSetEmail(app.id, emailDraft.trim() || null); setEditingEmail(false); } }}
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                />
              ) : (
                <button onClick={() => setEditingEmail(true)} className="font-mono text-[11px] hover:text-text underline decoration-dotted">
                  {app.contactEmail}
                </button>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-text-3">
              <ExternalLink className="w-3.5 h-3.5" />
              No contact email — copy the message and apply via the job link
              <button onClick={() => { setEditingEmail(true); }} className="text-[var(--brand)] hover:underline ml-1">add email</button>
            </span>
          )}
          {!hasEmail && editingEmail && (
            <input
              autoFocus type="email" placeholder="hr@company.com" value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              onBlur={() => { onSetEmail(app.id, emailDraft.trim() || null); setEditingEmail(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") { onSetEmail(app.id, emailDraft.trim() || null); setEditingEmail(false); } }}
              className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
            />
          )}
          {app.voiceRewritten && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-600 text-white">
              <Sparkles className="w-3 h-3" /> Personalised in your voice
            </span>
          )}
        </div>
      </div>

      {/* Section toggle */}
      <div className="px-4 pt-3">
        <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded p-0.5 w-fit">
          {([["email", "Email message", Mail], ["cover", "Cover letter", FileType], ["cv", "Tailored CV", FileText]] as const).map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => setSection(k)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                section === k ? "bg-[var(--surface)] text-text shadow-sm" : "text-text-2 hover:text-text"
              }`}
            >
              <Icon className="w-3 h-3" /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* Section body */}
      <div className="px-4 py-3">
        {section === "email" ? (
          <div className="space-y-2">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-1">Subject</label>
              <input
                value={app.emailSubject}
                onChange={(e) => onPatch(app.id, { emailSubject: e.target.value })}
                className="w-full text-[13px] px-3 py-2 rounded border border-border bg-surface text-text focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-1">Message to the employer</label>
              <textarea
                value={app.emailBody}
                onChange={(e) => onPatch(app.id, { emailBody: e.target.value })}
                rows={7}
                className="w-full text-[13px] leading-relaxed px-3 py-2 rounded border border-border bg-surface text-text resize-y focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
              />
              <p className="text-[10px] text-text-3 mt-1">Tailored CV + cover letter are attached as PDFs — keep this short.</p>
            </div>
          </div>
        ) : (
          <pre className="text-[12px] leading-relaxed text-text-2 whitespace-pre-wrap font-sans bg-[var(--surface-2)] border border-border rounded p-3 max-h-60 overflow-y-auto">
            {section === "cover" ? app.coverLetter : app.cvSummary}
          </pre>
        )}
      </div>

      {/* Action bar */}
      <div className="px-4 py-3 border-t border-border flex items-center gap-2 flex-wrap">
        {hasEmail ? (
          <button
            onClick={() => onMove(app.id, "sent")}
            className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[12px] px-3 py-1.5"
          >
            <Send className="w-3.5 h-3.5" /> Send email
          </button>
        ) : (
          <>
            <button onClick={copyMessage} className="inline-flex items-center gap-1 gh-btn text-[12px] px-3 py-1.5">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied" : "Copy email"}
            </button>
            <button
              onClick={() => onMove(app.id, "sent")}
              className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[12px] px-3 py-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Apply now
            </button>
          </>
        )}

        {/* Secondary actions behind a ··· menu */}
        <div className="relative ml-auto">
          <button
            onClick={() => setMenu((m) => !m)}
            className="inline-flex items-center gap-1 gh-btn text-[12px] px-2 py-1.5"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menu && (
            <div className="absolute right-0 bottom-full mb-1 w-48 bg-surface border border-border rounded-md shadow-lg py-1 z-10">
              {[
                ["Edit cover letter", Pencil],
                ["Cover letter PDF", FileType],
                ["Tailored CV PDF", FileText],
                ["Full analysis", FileText],
                ["Download ZIP", Download],
              ].map(([label, Icon]) => {
                const I = Icon as typeof Pencil;
                return (
                  <button key={label as string} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-2 hover:bg-[var(--surface-2)] hover:text-text text-left">
                    <I className="w-3.5 h-3.5" /> {label as string}
                  </button>
                );
              })}
              <div className="border-t border-border my-1" />
              <button
                onClick={() => { onMove(app.id, "archived"); setMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-3 hover:bg-[var(--surface-2)] hover:text-text text-left"
              >
                <Archive className="w-3.5 h-3.5" /> Archive
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sent / Archived card — minimal ──────────────────────────────────────────

function DoneCard({ app, onMove }: { app: MockApp; onMove: (id: string, s: Stage) => void }) {
  const isSent = app.stage === "sent";
  return (
    <div className="bg-surface border border-border rounded-md p-4 anim-in">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <a href="#" className="text-[14px] font-semibold text-text hover:text-[var(--brand)] transition-colors">{app.title}</a>
            {isSent ? (
              <span className="badge badge-green text-[10px] px-1.5 h-4 font-bold">Applied</span>
            ) : (
              <span className="badge badge-gray text-[10px] px-1.5 h-4 font-bold">Archived</span>
            )}
          </div>
          <p className="text-[12px] text-text-2 truncate mt-0.5">{app.company} · {app.location} · via {app.source}</p>
          <p className="text-[11px] text-text-3 mt-1 flex items-center gap-1.5">
            {isSent
              ? <><CheckCircle2 className="w-3 h-3 text-emerald-600" /> {app.contactEmail ? `Emailed ${app.contactEmail}` : "Applied via job link"} · {app.letterAgo}</>
              : <><Archive className="w-3 h-3" /> Dismissed · {app.letterAgo}</>}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-[16px] font-bold tabular-nums ${scoreColor(app.score)}`}>{app.score}<span className="text-[10px] text-text-3 font-medium">/100</span></p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"><Download className="w-3 h-3" /> Download ZIP</button>
        {isSent ? (
          <button onClick={() => onMove(app.id, "archived")} className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors ml-auto">
            <Archive className="w-3 h-3" /> Archive
          </button>
        ) : (
          <button onClick={() => onMove(app.id, "send")} className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors ml-auto">
            <Send className="w-3 h-3" /> Restore to Ready to send
          </button>
        )}
      </div>
    </div>
  );
}
