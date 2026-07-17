"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/* ── Context ─────────────────────────────────────────────────────────── */

interface TabsCtx {
  value: string;
  onValueChange: (v: string) => void;
  triggers: string[];
  registerTrigger: (id: string) => void;
  unregisterTrigger: (id: string) => void;
}

const Ctx = createContext<TabsCtx | null>(null);

function useCtx(who: string) {
  const c = useContext(Ctx);
  if (!c) throw new Error(`<Tabs.${who}> must be inside <Tabs.Root>`);
  return c;
}

/* ── Root ────────────────────────────────────────────────────────────── */

export interface RootProps {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}

export function Root({ value, onValueChange, children, className }: RootProps) {
  const [triggers, setTriggers] = useState<string[]>([]);

  const registerTrigger = useCallback((id: string) => {
    setTriggers((prev) => prev.includes(id) ? prev : [...prev, id]);
  }, []);

  const unregisterTrigger = useCallback((id: string) => {
    setTriggers((prev) => prev.filter((x) => x !== id));
  }, []);

  const ctx = useMemo(
    () => ({
      value,
      onValueChange,
      triggers,
      registerTrigger,
      unregisterTrigger,
    }),
    [value, onValueChange, triggers, registerTrigger, unregisterTrigger],
  );

  return <Ctx.Provider value={ctx}><div className={className}>{children}</div></Ctx.Provider>;
}

/* ── List ────────────────────────────────────────────────────────────── */

export interface ListProps {
  children: ReactNode;
  className?: string;
}

export function List({ children, className = "" }: ListProps) {
  const { triggers, value, onValueChange } = useCtx("List");

  function handleKeyDown(e: KeyboardEvent) {
    const idx = triggers.indexOf(value);
    let next = idx;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      next = (idx + 1) % triggers.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      next = (idx - 1 + triggers.length) % triggers.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      next = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      next = triggers.length - 1;
    } else {
      return;
    }
    onValueChange(triggers[next]);
    // move focus after React re-renders
    requestAnimationFrame(() => {
      document.getElementById(`tab-${triggers[next]}`)?.focus();
    });
  }

  return (
    <div role="tablist" className={className} onKeyDown={handleKeyDown}>
      {children}
    </div>
  );
}

/* ── Trigger ─────────────────────────────────────────────────────────── */

export interface TriggerProps {
  value: string;
  children: ReactNode;
  className?: string;
}

export function Trigger({ value, children, className = "" }: TriggerProps) {
  const { value: selected, onValueChange, registerTrigger, unregisterTrigger } = useCtx("Trigger");
  const active = selected === value;

  useEffect(() => {
    registerTrigger(value);
    return () => unregisterTrigger(value);
  }, [value, registerTrigger, unregisterTrigger]);

  return (
    <button
      id={`tab-${value}`}
      role="tab"
      type="button"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      aria-controls={`panel-${value}`}
      onClick={() => onValueChange(value)}
      className={
        "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-1 " +
        (active
          ? "border-b-2 border-[var(--brand)] text-[var(--brand)]"
          : "border-b-2 border-transparent text-text-2 hover:text-text") +
        " " +
        className
      }
    >
      {children}
    </button>
  );
}

/* ── Content ─────────────────────────────────────────────────────────── */

export interface ContentProps {
  value: string;
  children: ReactNode;
  className?: string;
}

export function Content({ value, children, className = "" }: ContentProps) {
  const { value: selected } = useCtx("Content");
  if (selected !== value) return null;

  return (
    <div
      id={`panel-${value}`}
      role="tabpanel"
      aria-labelledby={`tab-${value}`}
      className={className}
    >
      {children}
    </div>
  );
}
