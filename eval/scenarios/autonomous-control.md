Turn 1:

Configure the autonomous loop with exactly this payload and then pause it:
- `enabled: true`
- `paused: false`
- `intervalMs: 60000`
- `verificationCommands: [["bun", "run", "typecheck"]]`
- `evaluationScenarios: ["autonomous-run"]`
- `failurePolicy: { maxConsecutiveFailures: 3, escalationAction: "pause_loop" }`
- `objectives: []`
- `replaceObjectives: true`

Call exactly `evolver_autonomous_configure` and then `evolver_autonomous_pause`.

---

Turn 2:

Resume the autonomous loop and then show its status.
Call exactly `evolver_autonomous_resume` and then `evolver_autonomous_status`.
Stop after status succeeds.
