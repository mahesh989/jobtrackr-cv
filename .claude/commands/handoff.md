Generate a handoff block for the next Claude Code session.

This is invoked when context is filling up and the user is about to 
start a new session. The handoff block must be self-contained — the 
next session has zero memory of this one.

Read the recent conversation context and produce a markdown block in 
this exact structure:

---
🔄 **Session boundary — paste this into your next session:**
```
Working on jobtrackr-cv.
[2-3 sentences: what just happened in this session — what was completed, what state things are in]
Read CLAUDE.md, .claude/graph.json, and docs/design.md for full context.
Next task: [1-2 sentences describing what's next]
Specific files to read first:
* [path] — [reason]
* [path] — [reason]
Suggested first command: [e.g. /plan implement X per docs/spec.md section Y]
Use claude-sonnet-4-6.
```
---

Rules for the handoff block:
- Maximum 200 words inside the code block
- Reference files on disk; do not restate their contents
- Always specify the model
- Always specify the first command if obvious
- The block must be copy-pasteable as-is
