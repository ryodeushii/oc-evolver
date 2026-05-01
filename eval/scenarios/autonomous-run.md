Turn 1:

Use these exact tool calls in order.

1. Call `evolver_autonomous_configure` once with the exact JSON-equivalent values below:

   - `intervalMs`: `0`
   - `verificationCommands`: `[]`
   - `evaluationScenarios`: `["smoke"]`
   - `failurePolicy`: `{ "maxConsecutiveFailures": 3, "escalationAction": "pause_loop" }`
   - `replaceObjectives`: `true`
   - `enabled`: `true`
   - `paused`: `false`
   - `objectives`: exactly this one-item array:

     ```json
     [
        {
          "prompt": "Make exactly one mutation by calling evolver_write_memory with memoryName \"autonomous-evidence-memory\" and document \"---\\nname: autonomous-evidence-memory\\ndescription: Autonomous evaluation evidence memory.\\n---\\n\\nAutonomous evaluation evidence memory.\". After the write succeeds, respond with exactly one short confirmation sentence. Do not call evolver_autonomous_run. Do not call status tools before the write.",
          "completionCriteria": {
            "changedArtifacts": ["memory:autonomous-evidence-memory"],
            "evaluationScenarios": ["objective-memory-evidence"],
            "verificationCommands": [["bun", "--version"]]
          }
        }
      ]
     ```

2. Call `evolver_autonomous_start` with no arguments so the queued objective runs through the normal inline autonomous start path.

Do not call `evolver_autonomous_run` with a prompt override.

---

Turn 2:

Use these exact tool calls in order.

1. Call `evolver_autonomous_status`.
2. Call `evolver_status`.

Do not call any other tools in turn 2.

Fail unless all of the following are true:
- the latest autonomous iteration decision is `promoted`
- the queued objective status is `completed`
- `lastCompletionEvidence.satisfied` is `true`
- `lastCompletionEvidence.changedArtifacts` includes `memory:autonomous-evidence-memory`
- `lastCompletionEvidence.passedEvaluationScenarios` includes both `smoke` and `objective-memory-evidence`
- `lastCompletionEvidence.passedVerificationCommands` includes `["bun", "--version"]`
- the registry has a non-null `currentRevision`

If any check fails, report the failure instead of claiming success.
