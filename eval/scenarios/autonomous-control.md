Turn 1:

Configure the autonomous loop with exactly this payload:
- `enabled: true`
- `paused: false`
- `intervalMs: 60000`
- `verificationCommands: [["bun", "run", "typecheck"]]`
- `evaluationScenarios: ["autonomous-run"]`
- `failurePolicy: { maxConsecutiveFailures: 3, escalationAction: "pause_loop" }`
- `objectives: []`
- `replaceObjectives: true`

Call exactly `evolver_autonomous_configure`.
Exit successfully after configure succeeds.

---

Turn 2:

Pause the configured autonomous loop.
Call exactly `evolver_autonomous_pause`.
Exit successfully after pause succeeds.

---

Turn 3:

Continue the same session.

Resume the autonomous loop.
Call exactly `evolver_autonomous_resume`.
Exit successfully after resume succeeds.

---

Turn 4:

Continue the same session.

Show the resumed loop status.
Call exactly `evolver_autonomous_status`.
Exit successfully after the status read completes.
