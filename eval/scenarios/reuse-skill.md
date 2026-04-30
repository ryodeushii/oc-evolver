Use `evolver_write_skill` directly.
Create a skill named `fixture-refactor`.
Its `SKILL.md` must have frontmatter with `name: fixture-refactor` and `description: Rewrite TODO markers in markdown files.`
Its body should say to use the helper script to replace `TODO` with `NOTE` in markdown files.
Also add the helper file `scripts/rewrite_todo_to_note.py` whose Python content reads `README.md` and replaces `TODO` with `NOTE`.
After the skill is written, stop.
---
Use `evolver_write_agent` directly.
Create a subagent named `fixture-reviewer`.
Its document must have frontmatter with `description: Review markdown changes after fixture refactors.` and `mode: subagent`.
Its body should say to review markdown changes and summarize any remaining risk.
After the agent is written, stop.
---
Use `evolver_apply_skill` for `fixture-refactor`, then update `README.md` so `TODO` becomes `NOTE`, then stop.
---
Use `evolver_run_agent` for `fixture-reviewer` with the prompt `Review README.md and summarize the markdown risk.`, then stop.
