/**
 * curlfetch.ts — spawn Python curl_cffi as a subprocess to fetch URLs with
 * Chrome 124 TLS impersonation, bypassing Cloudflare bot protection.
 *
 * Why a subprocess?
 *   curl_cffi is a Python library that patches libcurl to emit real Chrome
 *   JA3/ALPN TLS fingerprints. Node.js TLS (and got-scraping's spoofing) is
 *   detectable by Cloudflare's "ja3" check from datacenter IPs. curl_cffi is
 *   not detectable. The subprocess cost is ~200ms per call — trivial compared
 *   to the HTTP round-trip and well worth the reliable Cloudflare bypass.
 *
 * Prerequisites:
 *   Local dev:   pip install curl_cffi  (Python 3.8+)
 *   Production:  installed in Dockerfile (see /Dockerfile)
 *
 * The Python script is at scripts/fetch_jd.py (repo root → worker dir).
 * Path resolution works from both:
 *   src/lib/curlfetch.ts  (tsx dev)   →  ../../scripts/fetch_jd.py  ✅
 *   dist/lib/curlfetch.js (container) →  ../../scripts/fetch_jd.py  ✅
 */

import { spawn }         from "child_process";
import path              from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PY_SCRIPT  = path.resolve(__dirname, "../../scripts/fetch_jd.py");

export interface CurlFetchResult {
  status:    number;
  body:      string;
  /** Final URL after redirect chain (may differ from the requested URL). */
  url?:      string;
  /** Location header from a redirect response (populated when --no-redirect used). */
  location?: string;
}

/**
 * POST JSON to a URL using Python curl_cffi (Chrome 124 TLS impersonation).
 *
 * Same Cloudflare/bot-defence bypass as curlFetch, for JSON APIs that reject
 * plain clients via TLS fingerprinting (e.g. Dayforce's jobposting/search,
 * which 403s a normal fetch even from a residential IP). Extra headers (Referer,
 * Origin, X-Requested-With, …) are passed through as repeated --header args.
 */
export async function curlPostJson(
  url:       string,
  body:      unknown,
  headers:   Record<string, string> = {},
  proxyUrl?: string,
  timeoutMs: number = 35_000,
): Promise<CurlFetchResult> {
  return new Promise((resolve, reject) => {
    const args: string[] = [PY_SCRIPT, url, "--method", "POST", "--data", JSON.stringify(body)];
    for (const [k, v] of Object.entries(headers)) args.push("--header", `${k}: ${v}`);
    if (proxyUrl) args.push("--proxy", proxyUrl);

    const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`curlPostJson timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`fetch_jd.py exited ${code} for ${url}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      const raw = stdout.trim();
      if (!raw) { reject(new Error(`fetch_jd.py produced no output for ${url}`)); return; }
      try {
        resolve(JSON.parse(raw) as CurlFetchResult);
      } catch {
        reject(new Error(`fetch_jd.py output not valid JSON for ${url}: ${raw.slice(0, 200)}`));
      }
    });

    child.on("error", (err) => { clearTimeout(timer); reject(new Error(`spawn python3 failed: ${err.message}`)); });
  });
}

/**
 * Fetch a URL using Python curl_cffi (Chrome 124 TLS impersonation).
 *
 * @param url       - Target URL to fetch
 * @param proxyUrl  - Optional HTTP proxy URL (e.g. Apify residential proxy).
 *                    When set, requests route through the proxy IP — required
 *                    from Fly datacenter IPs to pass Cloudflare's IP-reputation
 *                    check (TLS fingerprinting alone isn't enough from datacenters).
 * @param timeoutMs - Subprocess wall-clock timeout (default 35 s — higher than
 *                    curl_cffi's own 25 s request timeout so we don't race it)
 */
export async function curlFetch(
  url:        string,
  proxyUrl?:  string,
  timeoutMs:  number = 35_000,
): Promise<CurlFetchResult> {
  return new Promise((resolve, reject) => {
    const args: string[] = [PY_SCRIPT, url];
    if (proxyUrl) args.push("--proxy", proxyUrl);

    const child = spawn("python3", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`curlFetch timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        const detail = stderr.trim() || "(no stderr)";
        reject(new Error(`fetch_jd.py exited ${code} for ${url}: ${detail}`));
        return;
      }

      const raw = stdout.trim();
      if (!raw) {
        reject(new Error(`fetch_jd.py produced no output for ${url}`));
        return;
      }

      try {
        const parsed = JSON.parse(raw) as CurlFetchResult;
        resolve(parsed);
      } catch {
        reject(
          new Error(
            `fetch_jd.py output not valid JSON for ${url}: ${raw.slice(0, 200)}`,
          ),
        );
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn python3 for curlFetch: ${err.message}. ` +
          "Is python3 installed? Run: pip install curl_cffi",
        ),
      );
    });
  });
}
