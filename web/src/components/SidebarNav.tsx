"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Briefcase,
  FileText,
  History,
  PenLine,
  UserCircle2,
  Plug,
  Palette,
  Lock,
  BarChart3,
  LogOut,
  Sparkles,
  Send,
  BookOpen,
  CreditCard,
  ShieldCheck,
  Users,
  Cpu,
  Activity,
  TrendingUp,
  FlaskConical,
  DollarSign,
  UserCheck,
  Database,
  ScrollText,
} from "lucide-react";

interface Profile {
  id: string;
  name: string;
  newCount: number;
  isRunning: boolean;
}

interface Props {
  email: string;
  profiles: Profile[];
  /** Count of completed-letter jobs awaiting the To-review pool decision. */
  poolCount?: number;
  /** users.role — drives which nav items are visible. founder/admin see the
   *  full nav (Analytics, Integrations); paid users see the product-only
   *  subset. Mirrors the role gate used by getEntitlement(). */
  role?: string;
}

// Founder/admin-only items live behind this check. Mirrors ADMIN_ROLES in
// lib/billing/entitlements.ts — keep these two in sync.
const ADMIN_ROLES = new Set(["founder", "admin"]);

/**
 * Sidebar nav. Visual structure adapted from cv-magic:
 *  - 256px wide on cv-magic themes (Classic / Notion / Clay / Gilded Noir),
 *    220px on Default — controlled by --sidebar-width on <html>.
 *  - Each item is icon + label, font-semibold for cv-magic themes.
 *  - Active state: solid bg fill on Default; 2px primary-coloured left
 *    border + soft tint on cv-magic themes (handled by .sidebar-item
 *    and .sidebar-item-active CSS in globals.css).
 *  - Logo: Sparkles icon + "JobTrackr" in serif (cv-magic themes pull
 *    the serif font from var(--font-serif-active)).
 */
function NavItem({
  href,
  icon: Icon,
  children,
  badge,
  exact,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  badge?: number;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={
        "sidebar-item flex items-center justify-between gap-2 px-3 rounded-[var(--sidebar-item-radius)] " +
        "text-[13px] font-semibold transition-colors group " +
        (active
          ? "sidebar-item-active bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active)]"
          : "text-[var(--sidebar-text)] hover:bg-[var(--sidebar-active-bg)] hover:text-[var(--sidebar-text-hover)]")
      }
      style={{ paddingTop: "var(--sidebar-item-py)", paddingBottom: "var(--sidebar-item-py)" }}
    >
      <span className="sidebar-item-inner flex items-center gap-2.5 min-w-0">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{children}</span>
      </span>
      {/* Hide the badge once the user is on the page — the "unread" cue is
          no longer useful when they're already looking at the content. */}
      {badge !== undefined && badge > 0 && !active && (
        <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--brand)] text-[var(--brand-fg)] text-[10px] font-bold flex items-center justify-center">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

export function SidebarNav({ email, poolCount = 0, role }: Props) {
  const isAdmin = ADMIN_ROLES.has(role ?? "");
  return (
    <aside className="flex flex-col h-full w-full overflow-y-auto select-none">

      {/* Logo — width / padding / font size adapts per theme via CSS */}
      <div className="sidebar-logo flex items-center gap-2.5 px-4 h-16 border-b border-[var(--sidebar-border)] shrink-0">
        <Sparkles className="h-5 w-5 text-[var(--brand)] shrink-0" />
        <span
          className="sidebar-logo-text font-semibold tracking-tight text-[16px] text-[var(--sidebar-text-hover)]"
          style={{ fontFamily: "var(--font-serif-active), Georgia, serif" }}
        >
          JobTrackr
        </span>
      </div>

      {/* Nav body */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">

        {/* Overview */}
        <div className="px-1 pb-1">
          <p className="text-[10px] font-semibold text-[var(--sidebar-text-dim)] uppercase tracking-widest mb-1">
            Overview
          </p>
        </div>
        <NavItem href="/dashboard" icon={LayoutDashboard} exact>Dashboard</NavItem>
        <NavItem href="/dashboard/instructions" icon={BookOpen}>Instructions</NavItem>

        {/* My profiles — single nav entry (NOT a per-profile list anymore).
            The full table with each profile's stats / Run / Jobs / Copy /
            Delete lives on the /dashboard/profiles page. Per-profile "new"
            counts are surfaced on the profile cards themselves, so we don't
            need a (potentially stale) aggregate badge in the sidebar. */}
        <NavItem href="/dashboard/profiles" icon={Briefcase}>
          Job Searches
        </NavItem>

        <NavItem href="/dashboard/applications" icon={Send} badge={poolCount || undefined}>Applications</NavItem>
        {/* Analytics is an operator/founder lens (pipeline funnels across
            sources and profiles) — paying users don't need it; they see
            their own dashboard funnel callouts instead. Hidden + the route
            redirects non-admins server-side. */}
        {isAdmin && <NavItem href="/dashboard/analytics" icon={BarChart3}>Analytics</NavItem>}
        <NavItem href="/dashboard/analyses" icon={History}>Analyses</NavItem>

        {/* Tools */}
        <div className="px-1 pt-4 pb-1">
          <p className="text-[10px] font-semibold text-[var(--sidebar-text-dim)] uppercase tracking-widest mb-1">
            Tools
          </p>
        </div>
        <NavItem href="/dashboard/settings/profile" icon={UserCircle2}>My Details</NavItem>
        <NavItem href="/dashboard/cv" icon={FileText}>CV library</NavItem>
        <NavItem href="/dashboard/voice" icon={PenLine}>Writing voice</NavItem>
        {/* Integrations bundles bring-your-own-key (AI providers) and Apify
            quota — both founder-only concerns. Paying users get hosted AI
            and don't manage Apify, so the page is hidden. The email-account
            connect that DID live here has moved to My Details → Email
            account so users can still set up Gmail/Outlook to send. */}
        {isAdmin && <NavItem href="/dashboard/integrations" icon={Plug}>Integrations</NavItem>}
        <NavItem href="/dashboard/billing" icon={CreditCard}>Billing</NavItem>
        <NavItem href="/dashboard/settings/theme" icon={Palette}>Theme</NavItem>
        <NavItem href="/privacy" icon={Lock}>Privacy policy</NavItem>

        {/* Admin section — founder/admin only ────────────────────────── */}
        {isAdmin && (
          <>
            <div className="px-1 pt-4 pb-1">
              <p className="text-[10px] font-semibold text-[var(--sidebar-text-dim)] uppercase tracking-widest mb-1">
                Admin
              </p>
            </div>
            <NavItem href="/dashboard/admin" icon={ShieldCheck} exact>Overview</NavItem>
            <NavItem href="/dashboard/admin/users" icon={Users}>Users</NavItem>
            <NavItem href="/dashboard/admin/ai-costs" icon={Cpu}>AI costs</NavItem>
            <NavItem href="/dashboard/admin/activity" icon={Activity}>Activity</NavItem>
            <NavItem href="/dashboard/admin/pipeline" icon={TrendingUp}>Pipeline health</NavItem>
            <NavItem href="/dashboard/admin/quality" icon={FlaskConical}>Quality</NavItem>
            <NavItem href="/dashboard/admin/metrics" icon={BarChart3}>Beta metrics</NavItem>
            <div className="px-1 pt-3 pb-1">
              <p className="text-[10px] font-semibold text-[var(--sidebar-text-dim)] uppercase tracking-widest mb-1">
                Business
              </p>
            </div>
            <NavItem href="/dashboard/admin/revenue"   icon={DollarSign}>Revenue</NavItem>
            <NavItem href="/dashboard/admin/retention" icon={UserCheck}>Retention</NavItem>
            <NavItem href="/dashboard/admin/sourcing"  icon={Database}>Sourcing health</NavItem>
            <NavItem href="/dashboard/admin/audit"     icon={ScrollText}>Audit log</NavItem>
          </>
        )}
      </nav>

      {/* User footer */}
      <div className="border-t border-[var(--sidebar-border)] px-3 py-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-[var(--sidebar-avatar-bg)] flex items-center justify-center shrink-0">
            <span className="text-[11px] font-bold text-[var(--sidebar-text)]">
              {email[0]?.toUpperCase()}
            </span>
          </div>
          <span className="text-[12px] text-[var(--sidebar-text)] truncate flex-1 min-w-0">{email}</span>
          <form action="/auth/signout" method="post">
            <button
              className="flex items-center gap-1 text-[11px] font-medium text-[var(--sidebar-text-dim)] hover:text-[var(--sidebar-text-hover)] transition-colors shrink-0 px-1.5 py-1 rounded hover:bg-[var(--sidebar-active-bg)]"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign out</span>
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
