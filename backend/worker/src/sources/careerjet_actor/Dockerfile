# Playwright base — Apify residential IPs receive a Cloudflare interstitial
# ("unusual traffic from your network") on careerjet.com.au /jobad pages.
# A real Chromium executes the challenge JS so Cloudflare's managed challenge
# auto-resolves; Cheerio could not. Slightly more compute than node-only,
# still well inside the $5/month budget for ~20 JDs per run.
FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=optional --no-audit --no-fund \
 && npm cache clean --force

COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
