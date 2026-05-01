Run a status-only autonomous evaluation check.

Requirements:
- Do not mutate any files.
- Call exactly `evolver_autonomous_status` and then `evolver_status`.
- Do not call any other tools.
- Exit successfully only after both status reads complete.
