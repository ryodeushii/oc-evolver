Turn 1:

Run one bounded autonomous preview inspection.

Requirements:
- Do not mutate any files.
- Call exactly `evolver_autonomous_preview`.
- Do not call any other tools.
- Exit this turn successfully only if the preview shows a queued bounded objective would run.

---

Turn 2:

Continue the same session.

Requirements:
- Do not mutate any files.
- Call exactly `evolver_autonomous_status`.
- Do not call any other tools.
- Exit successfully only if status still shows that same objective pending.
