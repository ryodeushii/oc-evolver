Run one autonomous stop inspection.

Requirements:
- Call exactly `evolver_autonomous_stop` and then `evolver_autonomous_status`.
- Do not call any other tools.
- Exit successfully only if stop disables and pauses the loop, and status reports the same stopped state.
