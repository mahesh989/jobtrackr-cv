Invoke the planner subagent to map out the work described in $ARGUMENTS.

Use the planner agent (defined in .claude/agents/planner.md). Pass the 
user's request as context. The planner will produce a structured plan 
without executing anything.

After the planner returns its plan, stop and present it to the user. 
Do not begin execution. The user will review and explicitly approve or 
revise before any work begins.
