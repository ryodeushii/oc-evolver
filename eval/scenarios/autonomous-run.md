Turn 1:

Continue the same session.

Use these exact tool calls in order.

1. Call `evolver_autonomous_start`.

Do not call `evolver_autonomous_run` with a prompt override.
Do not call any other tools in turn 1.
Exit successfully after the start call completes.

---

Turn 2:

Continue the same session.

Use these exact tool calls in order.

1. Call `evolver_autonomous_status`.

Do not call any other tools in turn 2.

Exit successfully after the autonomous status read completes.

---

Turn 3:

Continue the same session.

Use these exact tool calls in order.

1. Call `evolver_status`.

Do not call any other tools in turn 3.

Fail unless all of the following are true:
- the latest autonomous iteration decision is `promoted`
- the queued objective status is `completed`
- `lastCompletionEvidence.satisfied` is `true`
- `lastCompletionEvidence.changedArtifacts` includes `memory:autonomous-evidence-memory`
- `lastCompletionEvidence.passedEvaluationScenarios` includes both `smoke` and `objective-memory-evidence`
- `lastCompletionEvidence.passedVerificationCommands` includes `["bun", "--version"]`
- the registry has a non-null `currentRevision`

If any check fails, report the failure instead of claiming success.
