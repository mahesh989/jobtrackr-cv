"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  name:          string;
  defaultValue?: string;
  placeholder?:  string;
}

/**
 * Location field backed by Google Places Autocomplete (via /api/places/autocomplete).
 * Stays a normal text input — submits `name`, allows free typing (e.g. "Remote"),
 * and shows a suggestion dropdown once the user has typed 2+ characters.
 *
 * The ", Australia" suffix is stripped from selected values to keep the stored
 * string in the "Sydney NSW" shape the worker sources expect.
 */
export function LocationAutocomplete({ name, defaultValue = "", placeholder }: Props) {
  const [value, setValue]         = useState(defaultValue);
  const [suggestions, setSugg]    = useState<string[]>([]);
  const [open, setOpen]           = useState(false);
  const [active, setActive]       = useState(-1);

  const wrapRef    = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNext   = useRef(true); // suppress fetch on mount + after a selection

  // Debounced lookup whenever `value` changes from user typing.
  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 2) {
      // This guard clause is part of a debounced-fetch effect (setTimeout
      // below) that has to live in an effect regardless — the setState here
      // is incidental to that timer machinery, not a standalone sync-on-
      // change case that could move to render time.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guard inside a real debounce/timer effect
      setSugg([]);
      setOpen(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/places/autocomplete?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const { suggestions } = (await res.json()) as { suggestions: string[] };
        setSugg(suggestions);
        setOpen(suggestions.length > 0);
        setActive(-1);
      } catch {
        /* network hiccup — leave the field as plain text */
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function select(s: string) {
    skipNext.current = true;
    setValue(s.replace(/,\s*Australia$/i, ""));
    setOpen(false);
    setSugg([]);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      select(suggestions[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      {/* ponytail: raw input — controlled value/onChange/keyDown pattern
          doesn't fit <Input label="..." /> which owns its own label/id/state. */}
      <input
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        className="field"
      />
      {open && (
        <ul className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-md border border-border bg-surface shadow-lg">
          {suggestions.map((s, i) => (
            <li key={s}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); select(s); }} onMouseEnter={() => setActive(i)} className={`block w-full px-3 py-2 text-left text-[13px] text-text ${ i === active ? "bg-brand/10" : "" }`}>
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
