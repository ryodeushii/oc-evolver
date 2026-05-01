Run a status-only autonomous evaluation check.

Requirements:
- Do not intentionally mutate workspace content beyond the status-managed `.opencode/oc-evolver/registry.json` artifact.
- Call exactly `evolver_autonomous_status` and then `evolver_status`.
- Do not call any other tools.
- Exit successfully only after both status reads complete.
