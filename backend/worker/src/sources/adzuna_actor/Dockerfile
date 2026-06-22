# Lightweight Apify Node base — Cheerio over a residential AU proxy. The
# Adzuna /details page is plain static HTML (no Cloudflare, no JS challenge),
# so we don't need a browser. The only reason to use Apify residential here
# is to dodge Adzuna's per-IP rate limit that 429s the Fly worker IP for an
# hour at a time (verified 2026-06-22, Retry-After: 3600).
FROM apify/actor-node:20

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=optional --no-audit --no-fund \
 && npm cache clean --force

COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
