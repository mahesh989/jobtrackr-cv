.PHONY: dev stop fly-up fly-down fly-status help

REPO       := /Users/mahesh/Documents/Github/jobtrackr-cv
API_APP    := jobtrackr-cv-api
WORKER_APP := jobtrackr-worker

# Print every machine id for an app, space-separated. flyctl has no "start all
# machines in this app" verb, and machine ids CHANGE whenever a machine is
# destroyed and recreated — so they must be discovered, never hardcoded (the
# previous version pinned one api id and silently ignored the second machine).
define machine_ids
fly machine list --app $(1) --json 2>/dev/null | python3 -c "import json,sys;print(' '.join(m['id'] for m in json.load(sys.stdin)))"
endef

help:
	@echo "make dev          — kill existing processes, start web/api/worker locally"
	@echo "make stop         — stop local web/api/worker"
	@echo "make fly-up       — start Fly machines (for testing with real users)"
	@echo "make fly-down     — stop Fly machines (saves money)"
	@echo "make fly-status   — show machine state for both Fly apps"
	@echo "make schema-check — code vs migrations vs the LIVE database"

# The three-way check the 2026-08-08 outage needed and nobody had: what the
# CODE writes, what the MIGRATIONS declare, and what the DATABASE actually has.
# Reads Supabase creds from the worker's .env so it works with no extra setup.
.PHONY: schema-check
schema-check:
	@# Pull ONLY the two vars we need. Sourcing the whole .env breaks on values
	@# containing shell metacharacters — RESEND_FROM_EMAIL is `JobTrackr
	@# <noreply@…>`, whose unquoted `<` the shell reads as a redirect.
	@SUPABASE_URL=$$(grep -m1 '^SUPABASE_URL=' $(REPO)/backend/worker/.env | cut -d= -f2-) \
	 SUPABASE_SERVICE_ROLE_KEY=$$(grep -m1 '^SUPABASE_SERVICE_ROLE_KEY=' $(REPO)/backend/worker/.env | cut -d= -f2-) \
	 sh -c 'node $(REPO)/shared/supabase/scripts/check-code-schema.mjs --self-test && \
	        node $(REPO)/shared/supabase/scripts/check-code-schema.mjs && \
	        node $(REPO)/shared/supabase/scripts/check-schema-drift.mjs'

dev:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@$(MAKE) --no-print-directory kill-worker
	@sleep 1
	@osascript -e 'tell app "Terminal" to do script "cd $(REPO)/frontend/web && npm run dev"'
	@osascript -e 'tell app "Terminal" to do script "cd $(REPO)/backend/api && unset PYENV_VERSION && ~/.pyenv/shims/uvicorn app.main:app --reload"'
	@osascript -e 'tell app "Terminal" to do script "cd $(REPO)/backend/worker && npm run dev"'
	@echo "Started: web (3000), api (8000), worker"

stop:
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@$(MAKE) --no-print-directory kill-worker
	@echo "Stopped: web, api, worker"

# `npm run dev` in the worker is `tsx watch`, which forks a CHILD node process
# that does the actual work. Killing only the "tsx watch" wrapper leaves that
# child alive and still consuming the BullMQ queue — you then get TWO workers
# racing for jobs, and edits/env changes appear not to take effect because the
# stale process picked up the job. Kill the child pattern first, then the
# wrapper. Verified 2026-08-08 after exactly this bit during a debug session.
.PHONY: kill-worker
kill-worker:
	@pkill -f "preflight.cjs.*src/index.ts" 2>/dev/null || true
	@pkill -f "tsx watch.*worker/src/index" 2>/dev/null || true

# `fly scale count worker=1` does NOT start an existing-but-stopped machine —
# it only reconciles HOW MANY machines exist. When the worker has crash-looped
# to a stop (count is still 1), scale count is a silent no-op and you are left
# with no worker while the command reports success. Start machines explicitly.
fly-up:
	@for id in $$($(call machine_ids,$(API_APP))); do \
		echo "starting $(API_APP) $$id"; fly machine start $$id --app $(API_APP) || true; \
	done
	@for id in $$($(call machine_ids,$(WORKER_APP))); do \
		echo "starting $(WORKER_APP) $$id"; fly machine start $$id --app $(WORKER_APP) || true; \
	done
	@sleep 6
	@$(MAKE) --no-print-directory fly-status
	@osascript -e 'tell app "Terminal" to do script "cd $(REPO)/frontend/web && npm run dev"'
	@echo "web running at http://localhost:3000"

# Stop, don't scale to zero. `fly scale count worker=0` DESTROYS the machine;
# the next fly-up then creates a fresh one with a new id, losing the machine's
# event history (the crash-loop record that diagnoses why it went down) and
# rolling it onto whatever the latest release is. Stopping is reversible.
fly-down:
	@for id in $$($(call machine_ids,$(API_APP))); do \
		echo "stopping $(API_APP) $$id"; fly machine stop $$id --app $(API_APP) || true; \
	done
	@for id in $$($(call machine_ids,$(WORKER_APP))); do \
		echo "stopping $(WORKER_APP) $$id"; fly machine stop $$id --app $(WORKER_APP) || true; \
	done
	@echo "Fly machines stopped"

# fly-up reports success even when a machine starts and then immediately dies,
# because `fly machine start` returns as soon as the VM boots — not when the
# process inside stays up. This surfaces the state a few seconds later, so a
# crash loop is visible instead of silent. A machine that exited non-zero 10
# times is stuck until the cause is fixed: `fly logs -a <app> --no-tail` shows
# the throw, and Fly will not retry past its max restart count.
fly-status:
	@for app in $(API_APP) $(WORKER_APP); do \
		echo "── $$app"; \
		fly machine list --app $$app --json 2>/dev/null | python3 -c "import json,sys;[print('   %-16s %-9s %s' % (m['id'], m['state'], m.get('region',''))) for m in json.load(sys.stdin)]"; \
	done
