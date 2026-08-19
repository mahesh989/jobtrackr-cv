// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// C67: the "Saved" sidebar section's open/collapsed state was seeded from
// isSavedActive via useState's initial value — which only applies on the
// FIRST render. A client-side nav from elsewhere into /profiles/*
// afterward left the section collapsed, since nothing re-synced the state
// when the active route entered this section.

const mocks = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/features/jobs/components/AddModal", () => ({
  AddModal: () => null,
}));

vi.mock("@/components/providers/ScrollRestoration", () => ({
  resetScrollFor: () => {},
}));

import { SidebarLinks } from "./SidebarLinks";

const PROFILES = [{ id: "p1", name: "Aged Care Sydney", newCount: 0, isRunning: false }];

describe("SidebarLinks — Saved section auto-open", () => {
  it("is open on first render when already on a /profiles route", () => {
    mocks.pathname = "/profiles/p1";
    render(<SidebarLinks email="user@example.com" profiles={PROFILES} role="beta" />);
    expect(screen.queryByText("View all as list")).toBeTruthy();
  });

  it("auto-opens after a client-side nav into /profiles/*, without a prior manual open", () => {
    mocks.pathname = "/dashboard";
    const { rerender } = render(
      <SidebarLinks email="user@example.com" profiles={PROFILES} role="beta" />,
    );
    expect(screen.queryByText("View all as list")).toBeFalsy();

    mocks.pathname = "/profiles/p1";
    rerender(<SidebarLinks email="user@example.com" profiles={PROFILES} role="beta" />);

    expect(screen.queryByText("View all as list")).toBeTruthy();
  });
});
