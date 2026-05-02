Run a status-only autonomous evaluation check.

Requirements for turn 1:
- Do not intentionally mutate workspace content beyond the status-managed `.opencode/oc-evolver/registry.json` artifact.
- Call exactly `evolver_autonomous_status`.
- Do not call any other tools.
- Exit successfully after the autonomous status read completes.

---

Continue the same session.

Requirements for turn 2:
- Call exactly `evolver_status`.
- Do not call any other tools.
- Exit successfully after the registry status read completes.
