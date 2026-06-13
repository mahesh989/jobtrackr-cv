# Deploy SEEK AU Scraper to Apify

## One-time setup

### 1. Install Apify CLI
```bash
npm install -g apify-cli
apify login          # opens browser, signs into your Apify account
```

### 2. Build + deploy the actor
```bash
cd worker/apify-actors/seek-scraper
npm install
npm run build
apify push
```

After push completes, the CLI prints something like:
```
Actor seek-au-scraper created at https://console.apify.com/actors/<id>
```

Your actor ID will be: `<your-username>/seek-au-scraper`

### 3. Set SEEK_ACTOR_ID in the worker

**Local `.env`** (`worker/.env`):
```
SEEK_ACTOR_ID=<your-username>/seek-au-scraper
```

**Fly.io** (production worker secret):
```bash
fly secrets set SEEK_ACTOR_ID=<your-username>/seek-au-scraper --app jobtrackr-worker
```

---

## Test before using in pipeline

```bash
cd worker
npx tsx --env-file=.env src/scripts/testSeek.ts "Data Analyst"
```

You should see 20 real Data Analyst jobs from SEEK — correct titles, companies, locations.

---

## Updating the actor

Make changes to `src/main.ts`, then:
```bash
npm run build
apify push
```

Apify keeps the same actor ID. Worker sees the new version immediately on the next run.

---

## Proxy notes

The actor uses Apify's datacenter rotating proxies with `countryCode: 'AU'` by default.
This is included in Apify's free tier and works for SEEK's JSON API endpoint.

If you get consistent 403 errors, switch to residential proxies in `src/main.ts`:
```typescript
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
  countryCode: 'AU',
});
```
Note: residential proxies cost more — check your Apify plan before enabling.
