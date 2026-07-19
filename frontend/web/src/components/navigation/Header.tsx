"use client";

import { Button } from "@/components/ui";
import { MobileMenuButton } from "./MobileMenuButton";

export function Header() {
  return (
    <div className="md:hidden flex items-center gap-3 px-4 h-12 border-b border-border bg-surface shrink-0">
      <MobileMenuButton />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-wordmark.png" alt="JobTrackr" className="h-6 w-auto object-contain" />
      <div className="ml-auto flex items-center gap-2">
        <form action="/auth/signout" method="post">
          <Button size="sm">Sign out</Button>
        </form>
      </div>
    </div>
  );
}
