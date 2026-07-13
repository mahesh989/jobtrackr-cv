"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_ROLES } from "@/lib/constants";
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
  Eye,
  ArrowLeft,
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
  /** When true, an admin is previewing the user-facing UI ("View as user").
   *  Render the regular user nav + a "Back to admin" link instead of the
   *  admin nav. */
  userView?: boolean;
}

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pt-4 pb-1">
      <p className="text-[10px] font-semibold text-[var(--sidebar-text-dim)] uppercase tracking-widest mb-1">
        {children}
      </p>
    </div>
  );
}

function UserFooter({ email }: { email: string }) {
  return (
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
  );
}

function Logo() {
  return (
    <div className="sidebar-logo flex items-center px-4 h-16 border-b border-[var(--sidebar-border)] shrink-0">
      {/* The logo is the full "JobTrackr" wordmark, so no separate text label. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-wordmark.png" alt="JobTrackr" className="h-7 w-auto shrink-0 object-contain" />
    </div>
  );
}

export function SidebarNav({ email, poolCount = 0, role, userView = false }: Props) {
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(role ?? "");

  // ── Admin nav ─────────────────────────────────────────────────────────────
  // Founders/admins only see operational and business pages — no user-product
  // features (job board, applications, CV library, billing, etc.).
  // When userView is set, an admin is previewing the user UI → fall through to
  // the regular user nav below (with a "Back to admin" link).
  if (isAdmin && !userView) {
    return (
      <aside className="flex flex-col h-full w-full overflow-y-auto select-none">
        <Logo />
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">

          <SectionLabel>Operations</SectionLabel>
          <NavItem href="/dashboard/admin"          icon={ShieldCheck} exact>Overview</NavItem>
          <NavItem href="/dashboard/admin/users"    icon={Users}>Users</NavItem>
          <NavItem href="/dashboard/admin/ai-costs" icon={Cpu}>AI costs</NavItem>
          <NavItem href="/dashboard/admin/pipeline" icon={TrendingUp}>Pipeline health</NavItem>
          <NavItem href="/dashboard/admin/activity" icon={Activity}>Activity</NavItem>
          <NavItem href="/dashboard/admin/quality"  icon={FlaskConical}>Quality</NavItem>
          <NavItem href="/dashboard/admin/metrics"  icon={BarChart3}>Beta metrics</NavItem>
          <NavItem href="/dashboard/analytics"      icon={BarChart3}>Analytics</NavItem>

          <SectionLabel>Business</SectionLabel>
          <NavItem href="/dashboard/admin/revenue"   icon={DollarSign}>Revenue</NavItem>
          <NavItem href="/dashboard/admin/retention" icon={UserCheck}>Retention</NavItem>
          <NavItem href="/dashboard/admin/sourcing"  icon={Database}>Sourcing health</NavItem>
          <NavItem href="/dashboard/admin/audit"     icon={ScrollText}>Audit log</NavItem>

          <SectionLabel>System</SectionLabel>
          <NavItem href="/dashboard/admin/ai-settings"  icon={Sparkles}>AI provider</NavItem>
          <NavItem href="/dashboard/integrations"      icon={Plug}>Integrations</NavItem>
          <NavItem href="/dashboard/cv"                icon={UserCircle2}>My CV</NavItem>
          <NavItem href="/dashboard/settings/theme"    icon={Palette}>Theme</NavItem>
          <NavItem href="/privacy"                     icon={Lock}>Privacy policy</NavItem>

          <SectionLabel>Preview</SectionLabel>
          {/* Plain anchor — hits a route handler that sets the cookie + redirects. */}
          <a
            href="/api/admin/view-as?mode=user"
            className="sidebar-item flex items-center gap-2.5 px-3 rounded-[var(--sidebar-item-radius)] text-[13px] font-semibold text-[var(--sidebar-text)] hover:bg-[var(--sidebar-active-bg)] hover:text-[var(--sidebar-text-hover)] transition-colors"
            style={{ paddingTop: "var(--sidebar-item-py)", paddingBottom: "var(--sidebar-item-py)" }}
          >
            <Eye className="h-4 w-4 shrink-0" />
            <span className="truncate">View as user</span>
          </a>

        </nav>
        <UserFooter email={email} />
      </aside>
    );
  }

  // ── Regular user nav ──────────────────────────────────────────────────────
  return (
    <aside className="flex flex-col h-full w-full overflow-y-auto select-none">
      <Logo />

      {/* Nav body */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">

        {/* Admin previewing the user UI — banner + exit link. */}
        {userView && (
          <a
            href="/api/admin/view-as?mode=admin"
            className="mb-2 flex items-center gap-2 rounded-md border border-[var(--brand)]/40 bg-[var(--brand)]/10 px-3 py-2 text-[12px] font-semibold text-[var(--brand)] hover:bg-[var(--brand)]/20 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
            <span>Viewing as user · Back to admin</span>
          </a>
        )}

        <SectionLabel>Overview</SectionLabel>
        <NavItem href="/dashboard" icon={LayoutDashboard} exact>Dashboard</NavItem>
        <NavItem href="/dashboard/instructions" icon={BookOpen}>Instructions</NavItem>
        <NavItem href="/dashboard/profiles" icon={Briefcase}>Job Searches</NavItem>
        <NavItem href="/dashboard/applications" icon={Send} badge={poolCount || undefined}>Applications</NavItem>
        <NavItem href="/dashboard/analyses" icon={History}>Analyses</NavItem>

        <SectionLabel>Tools</SectionLabel>
        <NavItem href="/dashboard/cv" icon={FileText}>My CV</NavItem>
        <NavItem href="/dashboard/voice" icon={PenLine}>Writing voice</NavItem>
        <NavItem href="/dashboard/billing" icon={CreditCard}>Billing</NavItem>
        <NavItem href="/dashboard/settings/theme" icon={Palette}>Theme</NavItem>
        <NavItem href="/privacy" icon={Lock}>Privacy policy</NavItem>

      </nav>

      <UserFooter email={email} />
    </aside>
  );
}
