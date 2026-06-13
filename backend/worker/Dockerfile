# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
# node:22-slim (Debian/glibc) — required for Playwright's Chromium binary.
# @sparticuz/chromium is Lambda-only (Amazon Linux glibc); it fails on Alpine.
# We use Playwright's own managed Chromium install instead.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# System dependencies: Playwright Chromium libs + Python + curl_cffi
# curl_cffi provides Chrome 124 TLS impersonation for Cloudflare bypass
# (used by fetch_jd.py to scrape SEEK and Careerjet JD pages from Fly's IP).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 ca-certificates \
    python3-minimal python3-pip \
    && pip3 install --break-system-packages --no-cache-dir curl_cffi \
    && rm -rf /var/lib/apt/lists/* ~/.cache/pip

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
RUN npx playwright install chromium

COPY --from=build /app/dist ./dist

# Python JD-fetcher script (used by curl_cffi subprocess in curlfetch.ts)
COPY scripts/fetch_jd.py ./scripts/fetch_jd.py

CMD ["node", "dist/index.js"]
