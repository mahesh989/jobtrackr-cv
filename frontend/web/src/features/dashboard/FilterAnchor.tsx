"use client";

import { type ReactNode } from "react";
import Link from "next/link";

export function FilterAnchor({
  href, apply, className, onClick, children,
}: {
  href: string;
  apply?: (href: string) => void;
  className: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const internal = href.startsWith("/dashboard?");
  if (internal && apply) {
    return (
      <button type="button" onClick={() => { onClick?.(); apply(href); }} className={className} style={{ background: "none", border: "none", padding: 0, font: "inherit", textAlign: "left", color: "inherit", cursor: "pointer", }}>
        {children}
      </button>
    );
  }
  return (
    <Link
      href={href}
      scroll={!internal}
      onClick={onClick}
      className={className}
      style={{
        color: "inherit",
        textDecoration: "none",
      }}
    >
      {children}
    </Link>
  );
}
