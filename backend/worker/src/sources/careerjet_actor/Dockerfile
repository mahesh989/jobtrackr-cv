# Playwright base — a real Chromium so Cloudflare's managed challenge can
# auto-resolve on careerjet.com.au /jobad pages (residential IP alone isn't
# enough; Cheerio gets an interstitial).
FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=optional --no-audit --no-fund \
 && npm cache clean --force

# The base image ships with one Chromium revision, but `npm install playwright`
# above may resolve to a newer Playwright that expects a different revision —
# `chrome-headless-shell-XXXX not found`. Install the exact Chromium build the
# locally-resolved Playwright expects so they stay in lockstep.
RUN npx --no-install playwright install chromium

COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
