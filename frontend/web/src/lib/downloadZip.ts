import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import { renderTailoredCvBlob } from "@/lib/cv/pdfRender";
import type { ContactDetails } from "@/lib/types";

interface DownloadBundleParams {
  jobId: string;
  letterId: string;
  cvStoragePath: string;
  companyName: string;
  hiringManager?: string | null;
  editedBody?: string | null;
}

export async function downloadApplicationBundle({
  jobId,
  letterId,
  cvStoragePath,
  companyName,
  hiringManager,
  editedBody,
}: DownloadBundleParams) {
  // 1. Fetch user preferences to get formatted contact details and candidate name
  const prefsRes = await fetch("/api/user/preferences");
  let contactDetails: ContactDetails | null = null;
  if (prefsRes.ok) {
    const json = await prefsRes.json();
    if (json?.contact_details) {
      const cd = { ...json.contact_details };
      delete cd.projects;
      contactDetails = cd as ContactDetails;
    }
  }

  // 2. Fetch CV markdown from Supabase storage
  const supabase = createSupabaseClient();
  const { data: mdBlob, error: dlErr } = await supabase.storage
    .from("tailored-cvs")
    .download(cvStoragePath);
  if (dlErr || !mdBlob) {
    throw new Error(dlErr?.message ?? "Could not download CV markdown");
  }
  const markdown = await mdBlob.text();

  // 3. Render tailored CV PDF
  const cvBlob = await renderTailoredCvBlob({ markdown, contactDetails });

  // 4. Fetch cover letter PDF from API
  const params = new URLSearchParams({ format: "pdf" });
  if (hiringManager) params.append("hiring_manager_override", hiringManager);
  if (editedBody) params.append("edited_body", editedBody);

  const letterRes = await fetch(
    `/api/jobs/${jobId}/cover-letter/${letterId}/download?${params}`
  );
  if (!letterRes.ok) {
    throw new Error("Could not download cover letter PDF");
  }
  const letterBlob = await letterRes.blob();

  // 5. Load JSZip dynamically
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  // 6. LocalStorage tracker for collision handling
  const cleanCompany = (companyName || "Company").trim();
  const storageKey = `dl_count_${cleanCompany.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
  const currentCount = parseInt(localStorage.getItem(storageKey) || "0", 10);
  const nextCount = currentCount + 1;
  localStorage.setItem(storageKey, nextCount.toString());

  const suffix = currentCount > 0 ? ` (${currentCount})` : "";
  const folderName = `${cleanCompany}${suffix}`;

  // 7. Sanitize candidate name for PDF filenames
  const candidateName = contactDetails?.name || "Candidate";
  const sanitizedCandidateName = candidateName.trim().replace(/\s+/g, "_");

  // 8. Create folder in ZIP and add files
  const folder = zip.folder(folderName);
  if (!folder) throw new Error("Could not create ZIP folder");

  folder.file(`${sanitizedCandidateName}_CV.pdf`, cvBlob);
  folder.file(`${sanitizedCandidateName}_CovLetter.pdf`, letterBlob);

  // 9. Generate ZIP
  const zipContent = await zip.generateAsync({ type: "blob" });
  const zipName = `${folderName}.zip`;

  // 10. Deliver. Desktop handles a synthetic <a download> fine, but mobile
  // browsers (iOS Safari especially) silently ignore programmatic blob
  // downloads. When the Web Share API can take files, use it so mobile users
  // get a proper "Save to Files"/share sheet with the same company-named ZIP.
  const zipFile = new File([zipContent], zipName, { type: "application/zip" });
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [zipFile] })) {
    try {
      await nav.share({ files: [zipFile], title: folderName });
      return;
    } catch (err) {
      // User dismissed the share sheet → respect that, don't force a download.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Anything else (e.g. share unsupported for files at runtime) → fall
      // through to the anchor download below.
    }
  }

  const url = URL.createObjectURL(zipContent);
  const a = document.createElement("a");
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
