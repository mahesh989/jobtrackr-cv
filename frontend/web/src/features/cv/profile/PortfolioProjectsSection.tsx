"use client";

import { Plus, Trash2, ExternalLink } from "lucide-react";
import { Button, Input } from "@/ui";
import type { Project } from "./types";

export function PortfolioProjectsSection({
  projects, addProject, removeProject, patchProject,
}: {
  projects:     Project[];
  addProject:   () => void;
  removeProject: (i: number) => void;
  patchProject:  (i: number, field: keyof Project, value: string) => void;
}) {
  return (
    <div className="glass rounded-lg shadow-gold p-6 space-y-4">
      <div>
        <h2 className="label-luxury text-text-2">Portfolio Projects</h2>
        <p className="mt-1 text-xs text-text-3">
          These are passed to the AI when tailoring your CV — it will reference
          relevant projects for each role. Add name, live URL, and a one-line
          description.
        </p>
      </div>

      <div className="space-y-3">
        {projects.map((proj, i) => (
          <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-text-2">Project {i + 1}</span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => removeProject(i)}
                className="rounded p-1 hover:bg-red-light hover:text-red transition-colors"
                aria-label="Remove project"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Input
                  label="Name"
                  type="text"
                  value={proj.name ?? ""}
                  onChange={(e) => patchProject(i, "name", e.target.value)}
                  placeholder="e.g. CV Magic"
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Input
                    label="URL"
                    type="url"
                    value={proj.url ?? ""}
                    onChange={(e) => patchProject(i, "url", e.target.value)}
                    placeholder="https://github.com/you/project"
                  />
                  {proj.url && (
                    <a
                      href={proj.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-text-3 hover:text-[var(--brand)]"
                      aria-label="Open project URL"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <Input
                label="One-line description (optional)"
                type="text"
                value={proj.description ?? ""}
                onChange={(e) => patchProject(i, "description", e.target.value)}
                placeholder="e.g. AI-powered CV tailoring tool built with Next.js and FastAPI"
              />
            </div>
          </div>
        ))}
      </div>

      <Button
        variant="default"
        size="md"
        onClick={addProject}
        className="flex items-center gap-1.5 rounded-md border border-dashed w-full justify-center"
      >
        <Plus className="h-4 w-4" />
        Add project
      </Button>
    </div>
  );
}
