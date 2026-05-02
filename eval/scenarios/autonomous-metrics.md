Turn 1:

Run one read-only autonomous metrics inspection.

Requirements:
- Do not mutate any files.
- Call exactly `evolver_autonomous_metrics`.
- Do not call any other tools.

---

Turn 2:

Continue the same session.

Requirements:
- Do not mutate any files.
- Call exactly `evolver_autonomous_status`.
- Do not call any other tools.
- Exit successfully only if the metrics and status outputs agree on the persisted autonomous history.
