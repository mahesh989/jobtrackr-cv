# /pr-review — PR Review

Review the current branch's changes against main, or a specific scope.

If `$ARGUMENTS` specifies a scope (e.g. "the last 3 commits" or "backend/api only"), review that. Otherwise, review all changes in the current branch vs main.

Follow the PR review methodology in `.opencode/skills/pr-review.md`:

1. Get the diff (`git diff main...HEAD`)
2. Run CI checks relevant to changed services
3. Review every changed file across 6 dimensions (security, correctness, architecture, performance, testing, naming)
4. Categorize findings: Blockers, Warnings, Suggestions, Nits, What's Good
5. Score (start at 100, deduct per finding)
6. Provide concrete fix suggestions for Blockers and Warnings
7. Verdict: APPROVE / APPROVE_WITH_NOTES / REQUEST_CHANGES

After the review is complete, stop and present the full report to the user. If verdict is REQUEST_CHANGES, do not proceed to any other work — wait for user direction.
