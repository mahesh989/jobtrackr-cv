#!/bin/bash
# Fires on Claude Code Stop. Warns if graph.json wasn't updated this session.
GRAPH=".claude/graph.json"

if [ ! -f "$GRAPH" ]; then
  exit 0
fi

# Check if graph was modified in git working tree (staged or unstaged)
if git diff --quiet HEAD -- "$GRAPH" 2>/dev/null && git diff --cached --quiet -- "$GRAPH" 2>/dev/null; then
  # Check if it was committed in the last 10 minutes
  LAST_COMMIT_TIME=$(git log -1 --format="%ct" -- "$GRAPH" 2>/dev/null)
  NOW=$(date +%s)
  if [ -n "$LAST_COMMIT_TIME" ] && [ $((NOW - LAST_COMMIT_TIME)) -gt 600 ]; then
    echo ""
    echo "⚠️  GRAPH NOT UPDATED: .claude/graph.json was not changed this session."
    echo "   If you completed or started any tasks, update build_state and commit:"
    echo "   git add .claude/graph.json && git commit -m 'chore: update graph [$(date +%Y-%m-%d)]'"
    echo ""
  fi
fi
