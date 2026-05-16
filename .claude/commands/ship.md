Phase wrap-up ritual. Run these steps in order, stopping if any fail:

1. Verify the working tree is clean of unintended changes
   - `git status`
   - If unexpected files appear: stop, ask user

2. Update graph.json with completed work
   - Add entries for what was accomplished
   - Update next_action to point at the next logical work
   - Update phase status if relevant

3. Stage and commit
   - `git add -A`
   - Commit message format: "<type>: <short description>"
   - Types: feat, fix, chore, docs, refactor, test
   - Ask user to confirm message before committing

4. Push to main
   - `git push origin main`
   - Verify push succeeded

5. Output a phase summary
   - What was done
   - What was decided
   - What comes next (session boundary recommendation)

6. Recommend whether to /compact or start a fresh session
   - If context usage is below 40%: continue
   - If 40-60%: /compact and continue
   - If above 60%: end session, start fresh

Use $ARGUMENTS as the commit message hint if provided.
