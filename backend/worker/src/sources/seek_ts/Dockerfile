# Apify Playwright+Chromium base (Node 20). Runs as non-root 'myuser';
# --chown is required so npm can write package-lock.json during install.
FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=optional --no-audit --no-fund \
 && npm cache clean --force

COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
