Turn 1:

Run one autonomous stop inspection.

Requirements:
- Call exactly `evolver_autonomous_stop`.
- Do not call any other tools.

---

Turn 2:

Continue the same session.

Requirements:
- Call exactly `evolver_autonomous_status`.
- Do not call any other tools.
- Exit successfully only if stop disables and pauses the loop, and status reports the same stopped state.
