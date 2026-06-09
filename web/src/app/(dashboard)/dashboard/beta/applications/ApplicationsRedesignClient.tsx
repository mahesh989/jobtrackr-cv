"use client";

/**
 * Applications redesign v2 — interactive mock.
 *
 * 2-tab flow:
 *   Application pool — expandable big cards. Section tabs: Tailored CV (preview
 *     matching the analysis page), Cover letter (editable + saveable), Email
 *     message (editable subject + body). Action bar has document buttons (cover
 *     letter PDF, tailored CV PDF, download ZIP) + channel-adaptive send/apply.
 *   Sent / Applied — minimal done cards.
 *
 * Archive removes the card from this screen (lives in dashboard archive).
 *
 * Everything is local state — no network. The point is to feel the flow.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Inbox, Send, Archive, ChevronDown, ChevronRight, Mail, ExternalLink,
  FileText, FileType, Copy, Check, CheckCircle2, MoreHorizontal,
  Download, Sparkles, Save, Loader2,
} from "lucide-react";

// ── types & mock data ──────────────────────────────────────────────────────

type Stage = "pool" | "sent";

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
  coverLetterSaved: string; // tracks "saved" state for dirty detection
  cvMarkdown: string;
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

// Simulated markdown that matches how a real tailored CV looks in the analysis
// page preview (ReactMarkdown + remark-gfm rendered with CV_PDF_STYLE classes).
const SAMPLE_CV_MD = `# Maria Santos

**Hurstville NSW 2220** · 0412 345 678 · maria.santos@email.com · [LinkedIn](https://linkedin.com/in/mariasantos)

---

## Career Highlights

Dedicated Personal Care Assistant with 4+ years in residential aged care and home-based settings. Experienced in person-centred care delivery, medication assistance, and dementia-informed support across diverse client populations. Currently supporting a caseload of 12 community clients with Bolton Clarke, coordinating with RNs on evolving care plans and documenting via BESTMed.

---

## Care Skills

**Required Care Skills:** Personal care · Medication assistance · Dementia care · Mobility support · Continence care · Manual handling · Wound care · Infection control

**Other Skills:** BESTMed · MedMobile · Care planning · Client documentation

---

## Experience

### Bolton Clarke | Sydney NSW
**Personal Care Assistant** | 2022 – Present

- Deliver person-centred care to a caseload of 12 home-care clients across the St George region
- Administer medications and document via BESTMed, maintaining 100% compliance with medication management protocols
- Support clients with dementia using validation therapy and redirection techniques, reducing distress incidents by 30%
- Coordinate with RNs and allied health on evolving care plans, flagging clinical changes within the shift

### Anglicare | Sydney NSW
**Assistant in Nursing** | 2020 – 2022

- Provided personal care, mobility support, and continence assistance to 28 residents in a 64-bed aged care facility
- Assisted with wound care and infection control procedures under RN supervision
- Maintained accurate progress notes and incident reports in MedMobile

---

## Education

### TAFE NSW | Sydney NSW
**Certificate III in Individual Support (Ageing)** | 2020

---

## Credentials

First Aid · CPR · NDIS Worker Screening Check · National Police Check · Driver's Licence (NSW) · Manual Handling Certificate

**Work Rights:** Citizenship · Full Time`;

const APPS: MockApp[] = [
  {
    id: "a1",
    title: "Personal Care Assistant — Home Care | Penrith",
    company: "365 Care", location: "Penrith, Sydney NSW", source: "AIN Sydney",
    score: 81, stage: "pool", contactEmail: null, letterAgo: "today",
    coverLetter: SAMPLE_COVER, coverLetterSaved: SAMPLE_COVER, cvMarkdown: SAMPLE_CV_MD,
    emailSubject: "Application for Personal Care Assistant — Penrith Home Care",
    emailBody: "Dear Hiring Manager,\n\nPlease find attached my CV and cover letter for the Personal Care Assistant role in Penrith. I have 4+ years in aged and home care and would love to discuss how I can support your clients.\n\nKind regards,\nMaria Santos",
    voiceRewritten: true,
  },
  {
    id: "a2",
    title: "Aged Care Worker — Residential",
    company: "Bolton Clarke", location: "Chatswood NSW", source: "Aged Care NSW",
    score: 88, stage: "pool", contactEmail: null, letterAgo: "today",
    coverLetter: SAMPLE_COVER, coverLetterSaved: SAMPLE_COVER, cvMarkdown: SAMPLE_CV_MD,
    emailSubject: "Application for Aged Care Worker — Chatswood",
    emailBody: "Dear Hiring Manager,\n\nI'm applying for the Aged Care Worker role at Bolton Clarke. My CV and cover letter are attached.\n\nKind regards,\nMaria Santos",
    voiceRewritten: false,
  },
  {
    id: "a3",
    title: "Disability Support Worker",
    company: "Anglicare", location: "Parramatta NSW", source: "AIN Sydney",
    score: 74, stage: "pool", contactEmail: "careers@anglicare.org.au", letterAgo: "1d ago",
    coverLetter: SAMPLE_COVER, coverLetterSaved: SAMPLE_COVER, cvMarkdown: SAMPLE_CV_MD,
    emailSubject: "Application for Disability Support Worker — Parramatta",
    emailBody: "Dear Hiring Team,\n\nI'd like to apply for the Disability Support Worker position. Please find my tailored CV and cover letter attached. I bring NDIS experience and a current Worker Screening Check.\n\nKind regards,\nMaria Santos",
    voiceRewritten: true,
  },
  {
    id: "a4",
    title: "Home Care Assistant — Community",
    company: "Uniting", location: "Hurstville NSW", source: "Aged Care NSW",
    score: 79, stage: "pool", contactEmail: null, letterAgo: "2d ago",
    coverLetter: SAMPLE_COVER, coverLetterSaved: SAMPLE_COVER, cvMarkdown: SAMPLE_CV_MD,
    emailSubject: "Application for Home Care Assistant — Hurstville",
    emailBody: "Dear Hiring Manager,\n\nI'm writing to apply for the Home Care Assistant role in Hurstville. My CV and cover letter are attached for your review.\n\nKind regards,\nMaria Santos",
    voiceRewritten: false,
  },
  {
    id: "a5",
    title: "Personal Care Worker — Night Shift",
    company: "Opal HealthCare", location: "Killara NSW", source: "Aged Care NSW",
    score: 83, stage: "sent", contactEmail: "recruit@opal.com.au", letterAgo: "3d ago",
    coverLetter: SAMPLE_COVER, coverLetterSaved: SAMPLE_COVER, cvMarkdown: SAMPLE_CV_MD,
    emailSubject: "Application for Personal Care Worker — Night Shift",
    emailBody: "...", voiceRewritten: true,
  },
  {
    id: "a6",
    title: "Enrolled Nurse — Orthopaedics",
    company: "NSW Health", location: "Caringbah NSW", source: "Nursing NSW",
    score: 84, stage: "sent", contactEmail: null, letterAgo: "4d ago",
    coverLetter: SAMPLE_COVER, coverLetterSaved: SAMPLE_COVER, cvMarkdown: SAMPLE_CV_MD,
    emailSubject: "Application for Enrolled Nurse — Orthopaedics",
    emailBody: "...", voiceRewritten: false,
  },
];

const TABS: Array<{ key: Stage; label: string }> = [
  { key: "pool", label: "Application pool" },
  { key: "sent", label: "Sent / Applied" },
];

const TAB_HELP: Record<Stage, string> = {
  pool: "Review your tailored CV, cover letter, and email message for each job. Edit anything, then send or apply. Cards with a contact email send in one click; cards without one let you copy the message and apply via the job link.",
  sent: "Jobs you've applied to. Track outcomes here.",
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
    pool: apps.filter((a) => a.stage === "pool").length,
    sent: apps.filter((a) => a.stage === "sent").length,
  }), [apps]);

  const visible = apps.filter((a) => a.stage === tab);

  function move(id: string, stage: Stage) {
    setApps((prev) => prev.map((a) => (a.id === id ? { ...a, stage } : a)));
  }
  function remove(id: string) {
    setApps((prev) => prev.filter((a) => a.id !== id));
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
          {apps.length} job{apps.length !== 1 ? "s" : ""} with a completed cover letter ·{" "}
          <span className="text-[var(--brand)]">preview of the simplified 2-tab flow</span>
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
            <p className="text-[12px] text-text-2">
              {tab === "pool"
                ? "Generate a cover letter from any job's analysis page and it will appear here."
                : "Jobs you mark as applied will appear here."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((a) =>
              a.stage === "pool" ? (
                <PoolCard key={a.id} app={a} onMove={move} onRemove={remove} onSetEmail={setEmail} onPatch={patch} />
              ) : (
                <SentCard key={a.id} app={a} onRemove={remove} />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pool card — expandable big card with section tabs ─────────────────────────

function PoolCard({ app, onMove, onRemove, onSetEmail, onPatch }: {
  app: MockApp;
  onMove: (id: string, s: Stage) => void;
  onRemove: (id: string) => void;
  onSetEmail: (id: string, e: string | null) => void;
  onPatch: (id: string, p: Partial<MockApp>) => void;
}) {
  const [open, setOpen]         = useState(false);
  const [section, setSection]   = useState<"cv" | "cover" | "email">("cv");
  const [copied, setCopied]     = useState(false);
  const [saving, setSaving]     = useState(false);
  const [menu, setMenu]         = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft]     = useState(app.contactEmail ?? "");

  const hasEmail = !!app.contactEmail;
  const coverDirty = app.coverLetter !== app.coverLetterSaved;

  function copyMessage() {
    const payload = `Subject: ${app.emailSubject}\n\n${app.emailBody}`;
    navigator.clipboard?.writeText(payload).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function saveCoverLetter() {
    setSaving(true);
    // Simulate save — in real version this hits PATCH /api/applications/[letterId]
    setTimeout(() => {
      onPatch(app.id, { coverLetterSaved: app.coverLetter });
      setSaving(false);
    }, 600);
  }

  return (
    <div className="bg-surface border border-border rounded-md anim-in hover:border-[var(--text-3)] transition-colors">
      {/* Collapsed summary row */}
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
        <div className="flex items-center gap-3 shrink-0">
          {/* Channel indicator on collapsed row */}
          {hasEmail && (
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-text-3">
              <Mail className="w-3 h-3 text-[var(--brand)]" /> Email ready
            </span>
          )}
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-text-3">Tailored</p>
            <p className={`text-[18px] font-bold tabular-nums ${scoreColor(app.score)}`}>
              {app.score}<span className="text-[11px] text-text-3 font-medium">/100</span>
            </p>
          </div>
        </div>
      </button>

      {/* Expanded body */}
      {open && (
        <>
          {/* Channel chip + voice badge */}
          <div className="px-4 pb-2 border-t border-border pt-3">
            <div className="flex items-center gap-2 flex-wrap text-[12px]">
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
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)] w-56"
                    />
                  ) : (
                    <button onClick={() => { setEmailDraft(app.contactEmail ?? ""); setEditingEmail(true); }} className="font-mono text-[11px] hover:text-text underline decoration-dotted">
                      {app.contactEmail}
                    </button>
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-text-3">
                  <ExternalLink className="w-3.5 h-3.5" />
                  No contact email — copy the message and apply via the job link
                  <button onClick={() => { setEmailDraft(""); setEditingEmail(true); }} className="text-[var(--brand)] hover:underline ml-1">add email</button>
                </span>
              )}
              {!hasEmail && editingEmail && (
                <input
                  autoFocus type="email" placeholder="hr@company.com" value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  onBlur={() => { onSetEmail(app.id, emailDraft.trim() || null); setEditingEmail(false); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { onSetEmail(app.id, emailDraft.trim() || null); setEditingEmail(false); } }}
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)] w-56"
                />
              )}
              {app.voiceRewritten && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-600 text-white">
                  <Sparkles className="w-3 h-3" /> Personalised in your voice
                </span>
              )}
            </div>
          </div>

          {/* Section toggle: CV → Cover letter → Email */}
          <div className="px-4 pt-2 pb-1">
            <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded p-0.5 w-fit">
              {([
                ["cv",    "Tailored CV",    FileText],
                ["cover", "Cover letter",   FileType],
                ["email", "Email message",  Mail],
              ] as const).map(([k, label, Icon]) => (
                <button
                  key={k}
                  onClick={() => setSection(k)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-all ${
                    section === k ? "bg-[var(--surface)] text-text shadow-sm" : "text-text-2 hover:text-text"
                  }`}
                >
                  <Icon className="w-3 h-3" /> {label}
                  {k === "cover" && coverDirty && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Unsaved changes" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Section body */}
          <div className="px-4 py-3">
            {section === "cv" && (
              <CvPreview markdown={app.cvMarkdown} />
            )}

            {section === "cover" && (
              <div className="space-y-2">
                <textarea
                  value={app.coverLetter}
                  onChange={(e) => onPatch(app.id, { coverLetter: e.target.value })}
                  disabled={saving}
                  rows={12}
                  className="w-full text-[13px] leading-relaxed px-3 py-2 rounded border border-border bg-surface text-text resize-y focus:outline-none focus:ring-1 focus:ring-[var(--brand)] disabled:opacity-60"
                  spellCheck
                />
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-text-3">
                    {app.coverLetter.length} chars{coverDirty && " · unsaved changes"}
                  </span>
                  {coverDirty && (
                    <button
                      onClick={saveCoverLetter}
                      disabled={saving}
                      className="inline-flex items-center gap-1 gh-btn gh-btn-primary text-[11px] px-2.5 py-1 ml-auto disabled:opacity-40"
                    >
                      {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      {saving ? "Saving…" : "Save changes"}
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-text-3">
                  Changes here update the letter body, the downloadable PDF, and what gets attached to emails.
                </p>
              </div>
            )}

            {section === "email" && (
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
                    spellCheck
                  />
                  <p className="text-[10px] text-text-3 mt-1">Tailored CV + cover letter are attached as PDFs — keep this short.</p>
                </div>
              </div>
            )}
          </div>

          {/* Action bar */}
          <div className="px-4 py-3 border-t border-border flex items-center gap-2 flex-wrap">
            {/* Document buttons (left side) */}
            <button
              className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
              title="Open cover letter PDF in new tab"
            >
              <FileType className="w-3 h-3" /> Cover letter
            </button>
            <button
              className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
              title="Open tailored CV PDF in new tab"
            >
              <FileText className="w-3 h-3" /> Tailored CV
            </button>
            <button
              className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1"
              title="Download ZIP bundle containing CV + cover letter"
            >
              <Download className="w-3 h-3" /> Download ZIP
            </button>

            {/* Divider */}
            <div className="w-px h-5 bg-[var(--border)] mx-1" />

            {/* Send/Apply buttons (right side) */}
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

            {/* ··· menu */}
            <div className="relative ml-auto">
              <button
                onClick={() => setMenu((m) => !m)}
                className="inline-flex items-center gap-1 gh-btn text-[12px] px-2 py-1.5"
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {menu && (
                <>
                  {/* Click-away overlay */}
                  <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                  <div className="absolute right-0 bottom-full mb-1 w-48 bg-surface border border-border rounded-md shadow-lg py-1 z-20">
                    <a href="#" className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-2 hover:bg-[var(--surface-2)] hover:text-text">
                      <FileText className="w-3.5 h-3.5" /> Full analysis
                    </a>
                    <a href="#" className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-2 hover:bg-[var(--surface-2)] hover:text-text">
                      <ExternalLink className="w-3.5 h-3.5" /> Open job posting
                    </a>
                    <div className="border-t border-border my-1" />
                    <button
                      onClick={() => { onRemove(app.id); setMenu(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-3 hover:bg-[var(--surface-2)] hover:text-text text-left"
                    >
                      <Archive className="w-3.5 h-3.5" /> Archive
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── CV Preview — matches the Full Analysis page render ──────────────────────

function CvPreview({ markdown }: { markdown: string }) {
  // In production this would use ReactMarkdown + remarkGfm + applyCvSectionLayout
  // with CV_PDF_STYLE, exactly like TailoredCvCard.tsx. For this mock we render
  // the markdown with basic formatting to demonstrate the layout.

  // Parse the markdown into simple HTML-like sections for the preview.
  // This is a simplified render — the real version uses ReactMarkdown.
  const lines = markdown.split("\n");
  const elements: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("# ")) {
      // H1 — Name
      elements.push(
        <h1 key={i} className="text-[20px] font-bold text-gray-900 mb-1">{line.slice(2)}</h1>
      );
    } else if (line.startsWith("## ")) {
      // H2 — Section headers
      elements.push(
        <h2 key={i} className="text-[14px] font-bold text-gray-900 uppercase tracking-wider border-b border-gray-300 pb-0.5 mt-4 mb-2">{line.slice(3)}</h2>
      );
    } else if (line.startsWith("### ")) {
      // H3 — Institution / Company
      const text = line.slice(4);
      // Check if it's a "Company | Location" pattern
      const parts = text.split(" | ");
      if (parts.length === 2) {
        elements.push(
          <div key={i} className="flex justify-between items-baseline mt-2">
            <span className="text-[13px] font-bold text-gray-900">{parts[0]}</span>
            <span className="text-[12px] text-gray-600">{parts[1]}</span>
          </div>
        );
      } else {
        elements.push(
          <h3 key={i} className="text-[13px] font-bold text-gray-900 mt-2">{text}</h3>
        );
      }
    } else if (line.startsWith("**") && line.includes("** |")) {
      // Bold title | date row
      const clean = line.replace(/\*\*/g, "");
      const parts = clean.split(" | ");
      elements.push(
        <div key={i} className="flex justify-between items-baseline">
          <span className="text-[12px] font-semibold text-gray-800">{parts[0]}</span>
          {parts[1] && <span className="text-[11px] text-gray-500">{parts[1]}</span>}
        </div>
      );
    } else if (line.startsWith("- ")) {
      // Bullet point
      elements.push(
        <div key={i} className="flex gap-2 ml-1 mt-0.5">
          <span className="text-gray-400 shrink-0 text-[12px]">•</span>
          <span className="text-[12px] text-gray-700 leading-relaxed">{line.slice(2)}</span>
        </div>
      );
    } else if (line === "---") {
      elements.push(<hr key={i} className="border-gray-200 my-2" />);
    } else if (line.startsWith("**") && line.endsWith("**")) {
      // Standalone bold line (like "Work Rights: ...")
      const text = line.replace(/\*\*/g, "");
      elements.push(
        <p key={i} className="text-[12px] text-gray-800 mt-1"><strong>{text}</strong></p>
      );
    } else if (line.includes("**") && line.includes(":")) {
      // Inline bold label: value pattern (e.g. **Required Care Skills:** ...)
      const parts = line.split(/\*\*/g);
      elements.push(
        <p key={i} className="text-[12px] text-gray-700 mt-1 leading-relaxed">
          {parts.map((part, j) => j % 2 === 1 ? <strong key={j} className="text-gray-900">{part}</strong> : part)}
        </p>
      );
    } else if (line.trim()) {
      // Normal paragraph
      elements.push(
        <p key={i} className="text-[12px] text-gray-700 leading-relaxed">{line}</p>
      );
    }
    i++;
  }

  return (
    <div className="rounded-md border border-border bg-[var(--surface-2)] overflow-hidden">
      <div className="bg-white p-5 max-h-[420px] overflow-y-auto" style={{ colorScheme: "light" }}>
        <div className="max-w-[700px] mx-auto">
          {elements}
        </div>
      </div>
      <div className="px-3 py-1.5 border-t border-border bg-[var(--surface-2)]">
        <p className="text-[10px] text-text-3">
          Preview — same format as the Full Analysis page. Scroll to see more.
        </p>
      </div>
    </div>
  );
}

// ── Sent / Applied card — minimal ──────────────────────────────────────────

function SentCard({ app, onRemove }: { app: MockApp; onRemove: (id: string) => void }) {
  return (
    <div className="bg-surface border border-border rounded-md p-4 anim-in">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <a href="#" className="text-[14px] font-semibold text-text hover:text-[var(--brand)] transition-colors">{app.title}</a>
            <span className="badge badge-green text-[10px] px-1.5 h-4 font-bold">Applied</span>
          </div>
          <p className="text-[12px] text-text-2 truncate mt-0.5">{app.company} · {app.location} · via {app.source}</p>
          <p className="text-[11px] text-text-3 mt-1 flex items-center gap-1.5">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
            {app.contactEmail ? `Emailed ${app.contactEmail}` : "Applied via job link"} · {app.letterAgo}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-[16px] font-bold tabular-nums ${scoreColor(app.score)}`}>
            {app.score}<span className="text-[10px] text-text-3 font-medium">/100</span>
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1">
          <Download className="w-3 h-3" /> Download ZIP
        </button>
        <button className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1">
          <FileType className="w-3 h-3" /> Cover letter
        </button>
        <button className="inline-flex items-center gap-1 gh-btn text-[11px] px-2.5 py-1">
          <FileText className="w-3 h-3" /> Tailored CV
        </button>
        <button
          onClick={() => onRemove(app.id)}
          className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-2 py-1 transition-colors ml-auto"
        >
          <Archive className="w-3 h-3" /> Archive
        </button>
      </div>
    </div>
  );
}
