import type { NormalisedJob } from "../types.js";
import { setStage } from "../runLog.js";
import { extractVisaInfo } from "../../ai/visaExtractor.js";
import { classifySettings } from "../../ai/settingClassifier.js";
import {
  extractEmploymentTypes,
  extractEmails,
  extractTextSalary,
  extractClosingDate,
  extractShiftPatterns,
  detectAgency,
} from "../../ai/jdFacts.js";

/**
 * Stages 10a + 10c + 10e - per-job FACTS, shared by every profile:
 *   10a visa extraction (regex-first, AI only for ambiguous cases)
 *   10c work-setting classification (keyword-first, AI for ambiguous care jobs)
 *   10e JD facts (employment type, emails, salary, closing date, shifts, agency)
 *
 * Pure enrichment: count in === count out. Does NOT filter - the per-profile
 * filters that consume these facts run downstream (and, in bucket mode, inside
 * serveProfileFromBucket AFTER the shared write).
 */
export async function extractJobFacts(
  jobs: NormalisedJob[],
  runLogId: string,
): Promise<NormalisedJob[]> {
  // Stage 10a: visa extraction — regex-first, AI only for ambiguous cases
  // Runs on the full description of each new job (no truncation).
  // Sets sponsorship_status, citizen_pr_only, visa_extracted_text on each job.
  let visaReady = jobs;
  if (jobs.length > 0) {
    console.log(`[pipeline] stage 10a — extracting visa info for ${jobs.length} jobs`);
    await setStage(runLogId, `Extracting visa info (${jobs.length} jobs)`);
    const visaMap = await extractVisaInfo(jobs);
    visaReady = jobs.map((job) => {
      const info = visaMap.get(job.url_hash);
      if (!info) return job;
      return {
        ...job,
        sponsorship_status: info.sponsorship_status,
        citizen_pr_only: info.citizen_pr_only,
        visa_extracted_text: info.visa_extracted_text,
        work_rights_requirement: info.work_rights_requirement,
        // Keep visa_likelihood for sort compat — derived from binary result
        // (saved separately below via update, as it lives on the jobs table)
      };
    });
  }

  // Stage 10c: work-setting classification — keyword-first, AI only for
  // ambiguous care jobs (env SETTING_CLASSIFIER_AI). A shared, once-per-job
  // FACT (like visa): it flows into global_jobs and is reused by every profile.
  // The per-profile setting FILTER is separate (stage 10d / bucket serve).
  // Runs on EVERY fetched job before the bucket write so the shared bucket
  // always carries a setting label — the classifier skips non-care JDs cheaply
  // (a regex gate) and the AI tier only fires for ambiguous CARE jobs, so
  // classifying non-healthcare runs costs effectively nothing.
  let settingReady = visaReady;
  if (visaReady.length > 0) {
    await setStage(runLogId, `Classifying work setting (${visaReady.length} jobs)`);
    const settingMap = await classifySettings(visaReady);
    settingReady = visaReady.map((job) => {
      const info = settingMap.get(job.url_hash);
      if (!info) return job;
      return {
        ...job,
        setting_category: info.setting_category,
        setting_confidence: info.setting_confidence,
        setting_evidence: info.setting_evidence,
      };
    });
  }

  // Stage 10e: JD facts — employment type, contact emails, text salary,
  // closing date, shift patterns, agency flag (migration 080). Pure
  // regex/lexicon, no AI, so it runs on every survivor before the bucket
  // write: like visa/setting these are once-per-job FACTS shared via
  // global_jobs. Per-profile filtering on them happens at 10d / bucket serve.
  if (settingReady.length > 0) {
    const factsNow = new Date();
    settingReady = settingReady.map((job) => {
      const emp = extractEmploymentTypes({
        title: job.title,
        description: job.description,
        employment_types_raw: job.employment_types_raw,
      });
      const textSalary =
        job.salary_min == null ? extractTextSalary(job.description) : null;
      return {
        ...job,
        employment_types: emp.source ? emp.types : [],
        employment_source: emp.source,
        extracted_emails: extractEmails(job.description),
        ...(textSalary && {
          salary_min: textSalary.min,
          salary_max: textSalary.max ?? undefined,
          salary_period: textSalary.period,
        }),
        closing_date: extractClosingDate(job.description, factsNow),
        shift_patterns: extractShiftPatterns(job.description),
        is_agency: detectAgency(job.company, job.description),
      };
    });
    const withEmp = settingReady.filter((j) => (j.employment_types?.length ?? 0) > 0).length;
    const withEmail = settingReady.filter((j) => (j.extracted_emails?.length ?? 0) > 0).length;
    console.log(`[pipeline] stage 10e — JD facts: ${withEmp}/${settingReady.length} employment-typed, ${withEmail} with emails`);
  }

  return settingReady;
}
