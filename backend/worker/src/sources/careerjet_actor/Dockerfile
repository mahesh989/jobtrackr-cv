# Lightweight Apify Node base — no browser needed (Cheerio over residential
# proxy gets the raw HTML, since careerjet only Turnstile-challenges
# datacenter IPs). Much cheaper compute than the Playwright base.
FROM apify/actor-node:20

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=optional --no-audit --no-fund \
 && npm cache clean --force

COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
