Run one bounded autonomous preview inspection.

Requirements:
- Do not mutate any files.
- Call exactly `evolver_autonomous_preview` and then `evolver_autonomous_status`.
- Do not call any other tools.
- Exit successfully only if the preview shows a queued bounded objective would run and status still shows that same objective pending.
