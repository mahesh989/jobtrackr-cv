/**
 * cv-magic frontend formatters + layout helpers, ported verbatim.
 *
 * Order applied to the raw markdown in TailoredCvCard:
 *   padPipesAndCleanArtifacts(
 *     boldSkillCategories(
 *       stampContactClient(            ← new: re-stamps the contact line
 *         tidyContactLine(md),
 *         contactDetails               ← from /api/user/preferences
 *       )
 *     )
 *   )
 */

// ─── Contact line formatter (cv-magic verbatim) ────────────────────────────

export function tidyContactLine(md: string): string {
  if (!md) return md;
  const lines = md.split("\n");
  const h1Idx = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1Idx === -1) return md;
  const stop = lines.findIndex((l, i) => i > h1Idx && /^##\s+/.test(l));
  const end = stop === -1 ? lines.length : stop;

  const labelFor = (url: string): string | null => {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host.endsWith("linkedin.com")) return "LinkedIn";
      if (host.endsWith("github.com") || host.endsWith("gitlab.com")) return "GitHub";
      return "Portfolio";
    } catch { return null; }
  };

  for (let i = h1Idx + 1; i < end; i++) {
    let line = lines[i];
    if (!line.trim()) continue;
    line = line.replace(
      /\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_m, _label, url) => {
        const lab = labelFor(url);
        return lab ? `[${lab}](${url})` : `[${url}](${url})`;
      },
    );
    line = rewriteBareUrls(line, labelFor);
    lines[i] = line;
  }
  return lines.join("\n");
}

function rewriteBareUrls(line: string, labelFor: (url: string) => string | null): string {
  const skip: Array<[number, number]> = [];
  const linkRe = /\]\(([^)]+)\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(line)) !== null) {
    skip.push([lm.index + 2, lm.index + 2 + lm[1].length]);
  }
  const inSkip = (idx: number) => skip.some(([a, b]) => idx >= a && idx < b);

  const urlRe = /https?:\/\/[^\s)|]+/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(line)) !== null) {
    if (inSkip(m.index)) continue;
    const url = m[0];
    const lab = labelFor(url);
    result += line.slice(last, m.index);
    result += lab ? `[${lab}](${url})` : url;
    last = m.index + url.length;
  }
  result += line.slice(last);
  return result;
}

// ─── Bold the categories inside the Skills section ─────────────────────────

export function boldSkillCategories(md: string): string {
  if (!md) return md;
  const lines = md.split("\n");
  const startRe = /^##\s+(skills|technical skills|core skills)\s*$/i;
  const startIdx = lines.findIndex((l) => startRe.test(l.trim()));
  if (startIdx === -1) return md;
  const stop = lines.findIndex((l, i) => i > startIdx && /^##\s+/.test(l));
  const end = stop === -1 ? lines.length : stop;

  const markerRe = /^([-*•]\s+)?(.*)$/;
  for (let i = startIdx + 1; i < end; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    if (!trimmed) continue;
    const indent = raw.slice(0, raw.length - trimmed.length);
    const m = trimmed.match(markerRe);
    if (!m) continue;
    const marker = m[1] ?? "";
    const body = m[2] ?? "";
    if (body.startsWith("**")) continue;
    const colonIdx = body.indexOf(":");
    if (colonIdx <= 0) continue;
    const category = body.slice(0, colonIdx);
    const rest = body.slice(colonIdx + 1);
    lines[i] = `${indent}${marker}**${category}:**${rest}`;
  }
  return lines.join("\n");
}

// ─── Pad pipes / strip artefacts ───────────────────────────────────────────

export function padPipesAndCleanArtifacts(md: string): string {
  if (!md) return md;
  const lines = md.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^\s*\|/.test(line)) continue;

    const parts = line.split(/(`[^`]*`)/g);
    for (let p = 0; p < parts.length; p++) {
      if (p % 2 === 1) continue;
      let s = parts[p];
      s = s.replace(/(\S)\|/g, "$1 |");
      s = s.replace(/\|(\S)/g, "| $1");
      s = s.replace(/。/g, ".");
      s = s.replace(/、/g, ", ");
      s = s.replace(/ /g, " ");
      s = s.replace(/[​-‍﻿]/g, "");
      parts[p] = s;
    }
    lines[i] = parts.join("");
  }
  return lines.join("\n");
}

// ─── NEW: client-side contact-line stamp ───────────────────────────────────

export interface ContactDetails {
  name?:        string;
  phone?:       string;
  email?:       string;
  address?:     string;
  linkedin?:    string;
  github?:      string;
  website?:     string;
  portfolio?:   string;
  other_label?: string;
  other_url?:   string;
}

/**
 * Mirrors cv-backend's stamp_contact_line — replaces everything between H1
 * and the first H2 with a freshly-built contact line. Runs at PREVIEW time
 * so updates to /dashboard/settings/profile show up immediately without
 * re-running the analysis.
 *
 * Returns md unchanged when contact details are empty.
 */
export function stampContactClient(md: string, cd: ContactDetails | null | undefined): string {
  if (!md || !cd) return md;
  const parts = buildContactParts(cd);
  if (parts.length === 0 && !cd.name) return md;

  const lines = md.split("\n");
  const h1Idx = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1Idx === -1) return md;
  const nextH2 = lines.findIndex((l, i) => i > h1Idx && /^##\s+/.test(l));
  const stop = nextH2 === -1 ? lines.length : nextH2;

  // Optionally overwrite the name
  if (cd.name && cd.name.trim()) {
    lines[h1Idx] = `# ${cd.name.trim()}`;
  }

  const newBlock = parts.length > 0 ? ["", parts.join(" | "), ""] : [""];
  return lines.slice(0, h1Idx + 1).concat(newBlock, lines.slice(stop)).join("\n");
}

function buildContactParts(cd: ContactDetails): string[] {
  const parts: string[] = [];
  const clean    = (s?: string) => (s ?? "").trim();
  const cleanUrl = (s?: string) => {
    const v = clean(s);
    return v ? (v.startsWith("http") ? v : `https://${v}`) : "";
  };

  const address    = clean(cd.address);
  const phone      = clean(cd.phone);
  const email      = clean(cd.email);
  const linkedin   = cleanUrl(cd.linkedin);
  const github     = cleanUrl(cd.github);
  const portfolio  = cleanUrl(cd.portfolio);
  const website    = cleanUrl(cd.website);
  const otherLabel = clean(cd.other_label);
  const otherUrl   = cleanUrl(cd.other_url);

  if (address)   parts.push(address);
  if (phone)     parts.push(phone);
  if (email)     parts.push(`[${email}](mailto:${email})`);
  if (linkedin)  parts.push(`[LinkedIn](${linkedin})`);
  if (github)    parts.push(`[GitHub](${github})`);
  if (portfolio) parts.push(`[Portfolio](${portfolio})`);
  else if (website) parts.push(`[Website](${website})`);
  if (otherLabel && otherUrl) parts.push(`[${otherLabel}](${otherUrl})`);

  return parts;
}

// ─── Print-time DOM layout (h3/p pairs → two-column rows) ──────────────────

export function applyCvSectionLayout(root: HTMLElement) {
  const sectionNames = new Set([
    "professional experience",
    "experience",
    "clinical experience",
    "work experience",
    "education",
    "projects",
    "awards",
    "awards & achievements",
    "recognition",
    "recognitions",
    "honours",
    "honors",
    "accolades",
    "achievements",
  ]);

  // Award/recognition sections render as bullet lists ("* Name, Org (Date)"),
  // not H3 headers, so the H3 entry logic below skips them. These get the
  // dedicated bullet→two-column transform instead.
  const awardSectionNames = new Set([
    "awards",
    "awards & achievements",
    "recognition",
    "recognitions",
    "honours",
    "honors",
    "accolades",
    "achievements",
  ]);

  // Trailing parenthesised date on an award header ("…Nursing Home (August
  // 2025)"). Requires a 4-digit year inside the final parens so a non-date
  // parenthetical is never mistaken for the date. Mirrors the PDF renderer.
  const awardDateRe = /^([\s\S]*?)\s*\(([^()]*\b(?:19|20)\d{2}\b[^()]*)\)\s*$/;

  // Convert each award <li> into a bullet-free two-column entry (left =
  // name/org, right = date) with the description below — matching the
  // Experience/Education layout. Handles tight lists (<li>text<br>desc</li>)
  // and loose lists (<li><p>text<br>desc</p></li> / two <p>s). Returns true
  // when the section was handled (or was already converted — idempotent).
  const layOutAwardBullets = (nodes: HTMLElement[], slug: string): boolean => {
    if (nodes.some((n) => n.classList?.contains("cv-entry"))) return true;
    let handled = false;
    for (const node of nodes) {
      if (node.tagName !== "UL" && node.tagName !== "OL") continue;
      const lis = Array.from(node.querySelectorAll(":scope > li")) as HTMLElement[];
      if (lis.length === 0) continue;

      const frag = document.createDocumentFragment();
      for (const li of lis) {
        const ps = Array.from(li.querySelectorAll(":scope > p")) as HTMLElement[];
        const source = ps.length > 0 ? ps[0].innerHTML : li.innerHTML;
        let headHtml = source.trim();
        let descHtml = "";
        const br = headHtml.match(/<br\s*\/?>/i);
        if (br && br.index !== undefined) {
          descHtml = headHtml.slice(br.index + br[0].length).trim();
          headHtml = headHtml.slice(0, br.index).trim();
        }
        const extra = ps.slice(1).map((p) => p.innerHTML.trim()).filter(Boolean);
        if (extra.length) descHtml = [descHtml, ...extra].filter(Boolean).join(" ");

        const dm = headHtml.match(awardDateRe);
        const leftHtml = dm ? dm[1].trim() : headHtml;
        const rightHtml = dm ? dm[2].trim() : "";

        const entry = document.createElement("div");
        entry.className = "cv-entry cv-entry-" + slug;
        entry.appendChild(makeRow({ leftHtml, rightHtml }, true, false));
        if (descHtml) {
          const desc = document.createElement("p");
          desc.className = "cv-award-desc";
          desc.innerHTML = descHtml;
          entry.appendChild(desc);
        }
        frag.appendChild(entry);
      }
      node.replaceWith(frag);
      handled = true;
    }
    return handled;
  };

  const splitRow = (text: string) => {
    const value = text.trim();
    if (!value) return null;
    const patterns = [
      /^(.*)\s+\|\s+([^|]+)$/,
      /^(.*)\s+[—–]\s+([^—–]+)$/,
      // ASCII-hyphen fallback (tried last so pipe / em- / en-dash win first).
      // Matches the PDF renderer, which splits "Name - Org" on " - ".
      /^(.*)\s+-\s+([^-]+)$/,
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match && match[1] && match[2]) {
        return { left: match[1].trim(), right: match[2].trim() };
      }
    }
    return null;
  };

  const splitRowHtml = (node: HTMLElement, textParts: { left: string; right: string }) => {
    const html = node.innerHTML;
    const lastPipe = html.lastIndexOf(" | ");
    if (lastPipe !== -1) {
      return { leftHtml: html.slice(0, lastPipe).trim(), rightHtml: html.slice(lastPipe + 3).trim() };
    }
    for (const sep of [" – ", " — ", " - "]) {
      const idx = html.lastIndexOf(sep);
      if (idx !== -1) {
        return { leftHtml: html.slice(0, idx).trim(), rightHtml: html.slice(idx + sep.length).trim() };
      }
    }
    return { leftHtml: textParts.left, rightHtml: textParts.right };
  };

  const makeRow = (parts: { leftHtml: string; rightHtml: string }, isPrimary: boolean, isSecondary: boolean) => {
    const row = document.createElement("div");
    row.className = "cv-row" + (isPrimary ? " cv-row-primary" : "") + (isSecondary ? " cv-row-secondary" : "");
    const left = document.createElement("div");
    left.className = "cv-row-left";
    left.innerHTML = parts.leftHtml;
    const right = document.createElement("div");
    right.className = "cv-row-right";
    right.innerHTML = parts.rightHtml;
    row.append(left, right);
    return row;
  };

  const h2s = Array.from(root.querySelectorAll("h2"));
  for (const h2 of h2s) {
    const sectionName = (h2.textContent || "").trim().toLowerCase();
    if (!sectionNames.has(sectionName)) continue;

    const sectionNodes: HTMLElement[] = [];
    let walker = h2.nextElementSibling as HTMLElement | null;
    while (walker && walker.tagName !== "H2") {
      sectionNodes.push(walker);
      walker = walker.nextElementSibling as HTMLElement | null;
    }
    if (sectionNodes.length === 0) continue;

    // Award/recognition sections are bullet lists → convert to bullet-free
    // two-column entries. Falls through to the H3 logic only if there was no
    // list to transform (e.g. an award section authored with H3 headers).
    if (awardSectionNames.has(sectionName)) {
      const slug = sectionName.replace(/[^a-z0-9]+/g, "-");
      if (layOutAwardBullets(sectionNodes, slug)) continue;
    }

    const entries: HTMLElement[][] = [];
    let current: HTMLElement[] | null = null;
    for (const node of sectionNodes) {
      if (node.tagName === "H3") {
        if (current) entries.push(current);
        current = [];
        current.push(node);
        continue;
      }
      if (!current) current = [];
      current.push(node);
    }
    if (current && current.length > 0) entries.push(current);

    const sectionSlug = sectionName.replace(/[^a-z0-9]+/g, "-");
    for (const entry of entries) {
      const first = entry[0];
      const parent = first?.parentElement;
      if (!first || !parent) continue;

      const wrap = document.createElement("div");
      wrap.className = "cv-entry cv-entry-" + sectionSlug;
      parent.insertBefore(wrap, first);

      let rowCount = 0;
      for (const node of entry) {
        const tag = node.tagName;
        const candidate = tag === "H3" || tag === "P";
        if (candidate && rowCount < 2) {
          const textParts = splitRow(node.textContent || "");
          if (textParts) {
            const htmlParts = splitRowHtml(node, textParts);
            const row = makeRow(htmlParts, rowCount === 0, rowCount === 1);
            wrap.appendChild(row);
            rowCount += 1;
            if (node.parentNode) node.parentNode.removeChild(node);
            continue;
          }
          // Fail loud: an H3 is always meant to be a two-column header row, so a
          // heading with no recognised separator (| – — -) is an unknown shape,
          // not a paragraph. Tag it for inspection and warn outside production.
          if (tag === "H3") {
            node.setAttribute("data-cv-unsplit", "1");
            if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
              console.warn("[cv-layout] unsplit H3 header (no | / – / — / - separator):", node.textContent);
            }
          }
        }
        wrap.appendChild(node);
      }
    }
  }
}
