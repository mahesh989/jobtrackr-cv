# Playwright base — a real Chromium so Cloudflare's managed challenge can
# auto-resolve on careerjet.com.au /jobad pages (residential IP alone isn't
# enough; Cheerio gets an interstitial).
#
# Image tag pinned to a specific Playwright version (apify image tag pattern
# is <node>-<playwright>). package.json pins the SAME Playwright version, so
# the bundled Chromium matches what `npm install` resolves — no extra
# `playwright install` download needed (which was timing out the build).
FROM apify/actor-node-playwright-chrome:20-1.55.0

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=optional --no-audit --no-fund \
 && npm cache clean --force

COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
