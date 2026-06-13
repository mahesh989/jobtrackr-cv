# Deployment — seek-personal-jobtrackr

## 1. Install Apify CLI (if not already)
```bash
npm install -g apify-cli
apify login   # paste your Apify token
```

## 2. Deploy
```bash
cd seek-personal-jobtrackr
npm install
apify push
```
This builds and pushes the actor to your Apify account as `<your-username>/seek-personal-jobtrackr`.

## 3. Update your worker .env
```env
SEEK_ACTOR_ID=<your-apify-username>/seek-personal-jobtrackr
```

## 4. Test in Apify console first
Before running from JobTrackr, do a manual test run in the Apify console with:
```json
{
  "keywords": ["operations manager"],
  "location": "Sydney NSW",
  "dateRange": 7,
  "maxResults": 10
}
```

### Expected: jobs returned with id, title, company, location, area, salary, teaser, listingDate, url, workType, keyword
### If you get 0 results with HTTP 403 in the log → datacenter blocked, switch proxy:

In src/main.ts, uncomment the RESIDENTIAL line:
```ts
const proxyConfig = await Actor.createProxyConfiguration({
  groups: ["RESIDENTIAL"],  // ← uncomment this
});
```
Then `apify push` again.

## 5. Proxy cost reference
| Proxy group  | Cost/GB  | Typical for 200 results |
|---|---|---|
| DATACENTER   | ~$0.006  | ~$0.001                 |
| RESIDENTIAL  | ~$12.50  | ~$0.05–0.10             |

Start with datacenter. Only switch to residential if you see 403s.
