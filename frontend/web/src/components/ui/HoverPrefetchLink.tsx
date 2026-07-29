"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

/**
 * A <Link> that prefetches on pointer intent instead of on visibility.
 *
 * Next's automatic prefetch fires when a link enters the viewport, which is
 * the right default for a link buried in a page but the wrong one for a long
 * always-visible list: every row prefetches its whole route the moment it
 * paints, and they all compete for the ~6 connections the browser allows per
 * origin. Measured on the sidebar, that was 13 concurrent RSC requests fired
 * within 400ms of every single dashboard navigation.
 *
 * Next's own docs show `prefetch={active ? null : false}` + `onMouseEnter`
 * for this (prefetching.md → "Hover-triggered prefetch") — but that version
 * doesn't actually fire on the first hover: the same mouseenter event that
 * flips React state to re-render with the new prefetch value is also the
 * event Link's internal handler reads `prefetchEnabled` from, and it reads
 * the STALE (pre-update) value in that same synchronous pass. Confirmed with
 * a real trace: a single hover never fired a request, only a second one did —
 * meaning ordinary click-to-navigate use (hover once, click) got zero benefit
 * and was silently slower than before this component existed.
 *
 * This drives prefetching ourselves via `router.prefetch()` (Next's "Manual
 * prefetch" pattern) instead of routing through Link's prop-driven state
 * machine, so it fires on the actual first hover.
 */
export function HoverPrefetchLink({
  href,
  children,
  className,
  style,
  title,
  onClick,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: () => void;
}) {
  const router = useRouter();
  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={() => router.prefetch(href)}
      onClick={onClick}
      className={className}
      style={style}
      title={title}
    >
      {children}
    </Link>
  );
}
