Invoke the auditor subagent to review work completed in this session 
or in the current branch.

Use the auditor agent (defined in .claude/agents/auditor.md). 

If $ARGUMENTS specifies a scope (e.g. "the voice fingerprint module" or 
"the last 3 commits"), pass that as the review scope. Otherwise, default 
to: all changes in the current branch vs main.

After the auditor returns its verdict, stop and present the full review 
to the user. If verdict is FAIL or PASS_WITH_NOTES, do not proceed to 
any other work — wait for user direction on how to address findings.
