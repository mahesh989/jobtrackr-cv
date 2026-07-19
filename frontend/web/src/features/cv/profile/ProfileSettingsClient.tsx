"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { ContactDetails, Project, ProfileCredentials, RoleFamily } from "./types";
import { Button } from "@/components/ui";
import { ContactDetailsSection } from "./ContactDetailsSection";
import { RoleFamilyPicker } from "./RoleFamilyPicker";
import { TechLinksSection } from "./TechLinksSection";
import { PortfolioProjectsSection } from "./PortfolioProjectsSection";
import { HealthcareCredentialsSection } from "./HealthcareCredentialsSection";
import { ManualCredentialsSection } from "./ManualCredentialsSection";
import { AvailabilitySection as AvailabilitySectionSettings } from "./AvailabilitySectionSettings";

export type { ContactDetails, Project, ProfileCredentials, RoleFamily } from "./types";

interface Props {
  initial: ContactDetails | null;
}

const EMPTY: ContactDetails = {};

export function ProfileSettingsClient({ initial }: Props) {
  const router = useRouter();
  const [cd, setCd]             = useState<ContactDetails>(initial ?? EMPTY);
  const [projects, setProjects] = useState<Project[]>(initial?.projects ?? []);
  const [creds, setCreds]       = useState<ProfileCredentials>(initial?.credentials ?? {});
  const initFamilies = initial?.role_families ?? [];
  const [family, setFamily] = useState<RoleFamily | null>(initFamilies.length > 0 ? initFamilies[0] : null);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  function setField<K extends keyof ContactDetails>(k: K, v: string) {
    setCd((prev) => ({ ...prev, [k]: v }));
  }
  function setCred<K extends keyof ProfileCredentials>(k: K, v: ProfileCredentials[K]) {
    setCreds((prev) => ({ ...prev, [k]: v }));
  }
  function toggleAvailability(v: string) {
    setCreds((prev) => {
      const cur = prev.availability ?? [];
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      return { ...prev, availability: next };
    });
  }

  const showTech    = family === "tech" || family === "general";
  const showNursing = family === "nursing";
  const showManual  = family === "manual";

  function addProject() {
    setProjects((p) => [...p, { name: "", url: "", description: "" }]);
  }
  function removeProject(i: number) {
    setProjects((p) => p.filter((_, idx) => idx !== i));
  }
  function patchProject(i: number, field: keyof Project, value: string) {
    setProjects((p) => p.map((proj, idx) => idx === i ? { ...proj, [field]: value } : proj));
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/user/preferences", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          contact_details: { ...cd, projects, credentials: creds, role_families: family ? [family] : [] },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? `Failed (${res.status})`); return; }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ContactDetailsSection cd={cd} setField={setField} showTech={showTech} />
      <RoleFamilyPicker family={family} setFamily={setFamily} />

      {showTech && <TechLinksSection cd={cd} setField={setField} />}
      {showTech && (
        <PortfolioProjectsSection
          projects={projects}
          addProject={addProject}
          removeProject={removeProject}
          patchProject={patchProject}
        />
      )}
      {showNursing && <HealthcareCredentialsSection creds={creds} setCred={setCred} />}
      {showManual && <ManualCredentialsSection creds={creds} setCred={setCred} showNursing={showNursing} />}
      {(showNursing || showManual) && (
        <AvailabilitySectionSettings creds={creds} setCred={setCred} toggleAvailability={toggleAvailability} />
      )}

      {error && (
        <div className="rounded-md bg-red-light border border-red/20 px-3 py-2 text-[12px] text-red">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="md"
          onClick={save}
          disabled={busy}
          className="transition-shadow hover:glow-gold"
        >
          {busy ? "Saving…" : "Save preferences"}
        </Button>
        {savedFlash && <span className="text-sm text-green">✓ Saved</span>}
      </div>
    </div>
  );
}
