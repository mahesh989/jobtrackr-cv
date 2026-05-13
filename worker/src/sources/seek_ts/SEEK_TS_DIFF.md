# seek.ts — changes needed after deploying seek-personal-jobtrackr
# Everything else in seek.ts stays identical.

# ── 1. Change the Actor ID env var ───────────────────────────────────────────
# In your .env (worker):
-  SEEK_ACTOR_ID=prospect_fuzz~seek-au-scraper
+  SEEK_ACTOR_ID=mahesh/seek-personal-jobtrackr   # your Apify username + actor name

# ── 2. The request body is already correct ────────────────────────────────────
# Your seek.ts already sends exactly what the new actor expects:
#
#   body: JSON.stringify({
#     keywords:   profile.keywords,       ✅ string[]
#     location:   profile.location || "All Australia",  ✅ string
#     dateRange:  daysOld,                ✅ number (days)
#     maxResults: 200,                    ✅ number
#   })
#
# No changes needed to the request body.

# ── 3. Output field names are identical ──────────────────────────────────────
# New actor outputs:
#   id, title, company, location, area, salary, teaser,
#   listingDate, url, workType, keyword
#
# These match exactly what your SeekItem interface and mapper already read.
# No changes needed to the mapping logic.

# ── Summary ──────────────────────────────────────────────────────────────────
# Total lines changed in seek.ts: 1 (the SEEK_ACTOR_ID env var value)
# Everything else: zero changes required.
