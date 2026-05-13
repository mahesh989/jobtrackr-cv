"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Profile {
  id: string;
  name: string;
  newCount: number;
  isRunning: boolean;
}

interface Props {
  email: string;
  profiles: Profile[];
  isAdmin: boolean;
}

function NavItem({ href, children, badge, exact }: {
  href: string;
  children: React.ReactNode;
  badge?: number;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={`flex items-center justify-between gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors group ${
        active
          ? "bg-[#161B22] text-[#F0F6FF]"
          : "text-[#8B949E] hover:bg-[#161B22] hover:text-[#C9D1D9]"
      }`}
    >
      <span className="truncate">{children}</span>
      {badge !== undefined && badge > 0 && (
        <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-[#0969DA] text-white text-[10px] font-bold flex items-center justify-center">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

export function SidebarNav({ email, profiles, isAdmin }: Props) {
  return (
    <aside className="flex flex-col h-full w-full overflow-y-auto select-none">

      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-[#21262D] shrink-0">
        <div className="w-6 h-6 rounded-md bg-[#0969DA] flex items-center justify-center shrink-0">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="2" fill="white"/>
            <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.64 2.64l1.42 1.42M9.94 9.94l1.42 1.42M2.64 11.36l1.42-1.42M9.94 4.06l1.42-1.42"
              stroke="white" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </div>
        <span className="text-[#F0F6FF] font-semibold text-[14px] tracking-tight">JobTrackr</span>
      </div>

      {/* Nav body */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">

        {/* Overview */}
        <div className="px-2 pb-1">
          <p className="text-[10px] font-semibold text-[#484F58] uppercase tracking-widest mb-1">Overview</p>
        </div>
        <NavItem href="/dashboard" exact>Dashboard</NavItem>

        {/* Profiles */}
        <div className="px-2 pt-4 pb-1">
          <p className="text-[10px] font-semibold text-[#484F58] uppercase tracking-widest mb-1">My profiles</p>
        </div>

        {profiles.length === 0 ? (
          <p className="px-3 text-[12px] text-[#484F58] italic">No profiles yet</p>
        ) : (
          profiles.map((p) => (
            <NavItem
              key={p.id}
              href={`/dashboard/profiles/${p.id}/jobs`}
              badge={p.newCount}
            >
              <span className="flex items-center gap-1.5">
                {p.isRunning && (
                  <span className="relative flex h-1.5 w-1.5 shrink-0">
                    <span className="dot-ping absolute inline-flex h-full w-full rounded-full bg-[#0969DA] opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#0969DA]" />
                  </span>
                )}
                <span className="truncate">{p.name}</span>
              </span>
            </NavItem>
          ))
        )}

        <div className="px-3 pt-1">
          <Link
            href="/dashboard/profiles/new"
            className="flex items-center gap-1.5 text-[12px] text-[#484F58] hover:text-[#8B949E] transition-colors py-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            New profile
          </Link>
        </div>

        {/* Tools */}
        <div className="px-2 pt-4 pb-1">
          <p className="text-[10px] font-semibold text-[#484F58] uppercase tracking-widest mb-1">Tools</p>
        </div>
        <NavItem href="/dashboard/cv">CV library</NavItem>
        <NavItem href="/dashboard/integrations">Integrations</NavItem>
        <NavItem href="/privacy">Privacy policy</NavItem>

        {/* Admin */}
        {isAdmin && (
          <>
            <div className="px-2 pt-4 pb-1">
              <p className="text-[10px] font-semibold text-[#484F58] uppercase tracking-widest mb-1">Admin</p>
            </div>
            <NavItem href="/dashboard/admin">Users & Invites</NavItem>
            <NavItem href="/dashboard/admin/metrics">Beta Metrics</NavItem>
          </>
        )}
      </nav>

      {/* User footer */}
      <div className="border-t border-[#21262D] px-3 py-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-[#21262D] flex items-center justify-center shrink-0">
            <span className="text-[10px] font-bold text-[#8B949E]">
              {email[0]?.toUpperCase()}
            </span>
          </div>
          <span className="text-[12px] text-[#8B949E] truncate flex-1 min-w-0">{email}</span>
          <form action="/auth/signout" method="post">
            <button
              className="text-[11px] text-[#484F58] hover:text-[#8B949E] transition-colors shrink-0"
              title="Sign out"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
              </svg>
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
