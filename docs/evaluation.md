# Evaluation

## Overview

The evaluation harness runs OpenCode against a fresh temp workspace copied from `eval/fixtures/base/`. The bridge plugin file at `eval/fixtures/base/.opencode/plugins/oc-evolver.ts` is regenerated from the current repo source before each run.

Primary commands:

- `bun run eval:autonomous-run`
- `bun run eval:smoke`
- `bun run eval:all`
- `bun run scripts/run-eval.ts <scenario>`

The runner currently executes these default scenarios:

- `smoke`
- `create-skill`
- `create-agent`
- `command-runtime`
- `reuse-skill`
- `revision-lifecycle`
- `policy-deny`
- `invalid-artifact`
- `memory-guided-write`
- `artifact-only-deny`
- `autonomous-run`
- `autonomous-control`
- `autonomous-startup`
- `rollback`

Additional targeted helper scenarios exist outside the default batch:

- `objective-memory-evidence`

Pending revision lifecycle matters during evaluation: `evolver_write_*` tools stage a pending revision, while `evolver_promote` and `evolver_reject` decide whether that revision becomes the accepted registry state. `evolver_check` is the plugin-native health check for invalid artifacts plus pending revision state.

## Result artifacts

Each scenario writes artifacts under `eval/results/<scenario>/<timestamp>/`.

Key files:

- `result.json`: scenario name, workspace root, exit code, final command, changed files, turn count
- `response.json`: parsed OpenCode JSON events
- `stdout.txt`: raw OpenCode stdout stream
- `stderr.txt`: raw stderr stream
- `turns.json`: prompt, command, exit code, and session id per turn for multi-turn scenarios
- `audit.ndjson`: copied kernel audit log from the fixture workspace
- `registry.json`: copied kernel registry state from the fixture workspace

## Scenario expectations

### `smoke`

- Runs a status-only check
- Expected artifact signal:
  - exit code `0`
  - parsed `response.json`
  - empty or unchanged registry
  - no meaningful filesystem mutations

### `create-skill`

- Creates skill `fixture-refactor`
- Expected artifact signal:
  - `.opencode/skills/fixture-refactor/SKILL.md`
  - `.opencode/skills/fixture-refactor/scripts/rewrite_todo_to_note.py`
  - `write_skill` audit event
  - registry entry under `skills`

### `create-agent`

- Creates agent `fixture-reviewer`
- Expected artifact signal:
  - `.opencode/agent/fixture-reviewer.md`
  - supporting `fixture-refactor` skill bundle when the model needs to satisfy the agent's declared skill dependency
  - `write_agent` audit event
  - registry entry under `agents`

### `reuse-skill`

- Multi-turn scenario split with `---` separators in `eval/scenarios/reuse-skill.md`
- Expected artifact signal:
  - four turns in `turns.json`
  - one shared continued session id after turn 1
  - persisted session state under `.opencode/oc-evolver/sessions/`
  - `README.md` changes from `TODO` to `NOTE`
  - audit sequence includes `write_skill`, `write_agent`, `apply_skill`, `run_agent`

### `command-runtime`

- Exercises command-owned runtime metadata end to end
- Expected artifact signal:
  - `.opencode/memory/session-routing.md`
  - `.opencode/memory/command-routing.md`
  - `.opencode/commands/review-markdown.md` with command-owned `model`, `memory`, and `permission` metadata
  - persisted session state under `.opencode/oc-evolver/sessions/` retains both session-applied and command-owned memory
  - persisted runtime policy includes the command-owned memory/model/permission contract
  - audit sequence includes `write_memory`, `write_memory`, `apply_memory`, `write_command`, `run_command`

### `revision-lifecycle`

- Exercises the pending revision review, rejection, and prune path across two turns
- Expected artifact signal:
  - turn 1 executes `evolver_write_command`, `evolver_promote`, `evolver_delete_artifact`, then `evolver_review_pending`
  - turn 2 executes `evolver_reject` and then `evolver_prune`
  - durable pending-review evidence exists before prune
  - the accepted `review-markdown` command is restored after reject
  - the obsolete revision snapshot is pruned and no pending revision remains

### `policy-deny`

- Attempts a direct edit to `.opencode/plugins/oc-evolver.ts`
- Expected artifact signal:
  - protected plugin file remains byte-identical to the fixture baseline
  - changed files include only audit-related output
  - `audit.ndjson` contains `policy_denied`

### `invalid-artifact`

- Seeds an invalid skill bundle in the temp workspace and validates registry scope
- Expected artifact signal:
  - seeded `.opencode/skills/broken-skill/SKILL.md`
  - `audit.ndjson` contains `validate` failure with `failureClass: "invalid_artifact"`
  - `registry.json` contains quarantine metadata for the broken skill path

### `memory-guided-write`

- Prompts the model to create a reusable routing profile without naming the write tool directly
- Expected artifact signal:
  - `.opencode/memory/research-routing.md`
  - `audit.ndjson` contains `write_memory`
  - `registry.json` contains a `memories.research-routing` entry
  - changed files do not include a new repo-local policy or spec markdown file

### `artifact-only-deny`

- Applies an `artifact-only` memory profile, then attempts a Basic Memory note write
- Expected artifact signal:
  - `.opencode/memory/artifact-only-session.md`
  - persisted session state under `.opencode/oc-evolver/sessions/`
  - `audit.ndjson` contains `write_memory`, `apply_memory`, and `policy_denied`
  - the blocked Basic Memory write leaves no durable note artifact in the fixture workspace

### `autonomous-run`

- Runs one persisted autonomous-loop iteration against a queued objective
- Expected control-flow proof:
  - turn 1 executes exactly `evolver_autonomous_configure` then `evolver_autonomous_start`
  - turn 1 does not use `evolver_autonomous_run` or outer-session mutating tools
  - turn 2 executes exactly `evolver_autonomous_status` then `evolver_status`
- Expected artifact signal:
  - `.opencode/oc-evolver/autonomous-loop.json`
  - `audit.ndjson` contains `promote`
  - `registry.json.currentRevision` is non-null
  - the latest autonomous iteration records `decision: "promoted"`
  - the first queued objective finishes with `status: "completed"`
  - `lastCompletionEvidence.satisfied` is `true`
  - `lastCompletionEvidence.changedArtifacts` contains the required mutable artifact
  - `lastCompletionEvidence.passedEvaluationScenarios` contains both the baseline and objective-specific scenarios
  - `autonomous-loop.json.latestLearning.summary` describes a promoted iteration

Rejected or rolled-back ad-hoc iterations now leave behind a deterministic queued follow-up objective when the loop has explicit failure evidence to reuse. The synthesized objective reuses the failed iteration's changed artifacts plus failed verification commands and evaluation scenarios as explicit completion criteria, so later runs can continue from recorded evidence without manual queue edits.

The scheduler's durable lock now stores acquisition metadata and only self-recovers when that metadata proves the lock is stale. A fresh lock still produces `skipped_locked`, which keeps overlapping autonomous runs from deleting an active guard just to make progress.

### `autonomous-control`

- Exercises the non-mutating control plane for configure, pause, resume, and status across two turns
- Expected artifact signal:
  - turn 1 executes exactly `evolver_autonomous_configure` then `evolver_autonomous_pause`
  - turn 2 executes exactly `evolver_autonomous_resume` then `evolver_autonomous_status`
  - `.opencode/oc-evolver/autonomous-loop-paused.json` captures the paused snapshot from turn 1
  - `.opencode/oc-evolver/autonomous-loop.json` remains enabled, unpaused, and configured with `intervalMs: 60000`, `verificationCommands: [["bun", "run", "typecheck"]]`, `evaluationScenarios: ["autonomous-run"]`, and the required `pause_loop` failure policy
  - no loop iterations are recorded

### `autonomous-startup`

- Proves that persisted scheduled autonomous configuration restores at plugin startup before the model acts
- Expected artifact signal:
  - the single turn executes exactly `evolver_autonomous_status` and `evolver_status`
  - `audit.ndjson` contains durable `autonomous_restore` evidence
  - status output reflects the restored enabled scheduled state with `intervalMs: 60000`
  - restored verification/evaluation settings remain `[ ["bun", "run", "typecheck"] ]` and `["autonomous-run"]`
  - no loop iterations are recorded

### `objective-memory-evidence`

- Runs exactly one nested objective-evaluation turn as a status-only proof helper for `autonomous-run`
- Expected control-flow proof:
  - the scenario executes exactly one turn
  - it calls exactly `evolver_autonomous_status` and then `evolver_status`
  - it does not call any other tools or leave durable file changes
- Artifact note:
  - this scenario is exercised transitively by `autonomous-run`
  - standalone runs can still be captured under `eval/results/objective-memory-evidence/` when needed

### `rollback`

- Creates one mutable command revision, promotes it, overwrites it, promotes the replacement, then rolls the latest accepted revision back
- Expected artifact signal:
  - `.opencode/commands/review-markdown.md` restored to the first command body
  - `audit.ndjson` contains two `promote` events before `rollback`
  - `audit.ndjson` contains `rollback` with both the restored and rolled-back revision ids
  - `registry.json.currentRevision` points at the restored revision
  - `registry.json.pendingRevision` is `null`

## Failure inspection

When a scenario fails, inspect these files in order:

1. `result.json`
2. `response.json`
3. `audit.ndjson`
4. `registry.json`
5. `stdout.txt`
6. `stderr.txt`

Common failure classes:

- Protected path mutation: inspect `audit.ndjson` for `policy_denied`
- Invalid artifact rejection: inspect `registry.json.quarantine` and `audit.ndjson`
- Session continuity loss: inspect `turns.json` for missing `sessionID`
- Unexpected file noise: inspect `result.json.changedFiles`

## Latest verification matrix

This section is updated from the latest available artifact for each scenario.

| Check | Command | Status | Notes |
| --- | --- | --- | --- |
| TypeScript | `bun run typecheck` | PASS | Fresh clean `tsc --noEmit` run on current HEAD |
| Focused autonomous verification | `bun test tests/unit/autonomous-loop.test.ts tests/unit/eval-scenarios.test.ts tests/unit/plugin-tools.test.ts` | PASS | `69 pass`, `0 fail`, `220 expect()` |
| Real autonomous eval | `bun run eval:autonomous-run` | PASS | Latest artifact: `eval/results/autonomous-run/2026-04-30T23-46-19.905Z/` |
| Smoke eval | `bun run scripts/run-eval.ts smoke` | PASS | Latest artifact: `eval/results/smoke/2026-04-30T15-43-54.231Z/` |
| Historical broader suite | `bun run test:unit` | PASS | Earlier sweep: `70 pass`, `0 fail`, `225 expect()` |

## Latest scenario artifacts

- `smoke`: `eval/results/smoke/2026-04-30T15-43-54.231Z/`
  - `exitCode: 0`
  - `changedFiles: 2`
- `create-skill`: `eval/results/create-skill/2026-04-30T15-43-54.286Z/`
  - `exitCode: 0`
  - `changedFiles: 5`
- `create-agent`: `eval/results/create-agent/2026-04-30T15-43-54.646Z/`
  - `exitCode: 0`
  - `changedFiles: 4`
- `reuse-skill`: `eval/results/reuse-skill/2026-04-30T15-45-00.310Z/`
  - `exitCode: 0`
  - `turnCount: 4`
  - `changedFiles: 9`
- `policy-deny`: `eval/results/policy-deny/2026-04-30T15-45-00.356Z/`
  - `exitCode: 0`
  - `changedFiles: 1`
- `invalid-artifact`: `eval/results/invalid-artifact/2026-04-30T15-45-00.454Z/`
  - `exitCode: 0`
  - `changedFiles: 3`
- `memory-guided-write`: `eval/results/memory-guided-write/2026-04-30T15-46-10.252Z/`
  - `exitCode: 0`
  - `changedFiles: 4`
- `artifact-only-deny`: `eval/results/artifact-only-deny/2026-04-30T15-46-10.316Z/`
  - `exitCode: 0`
  - `turnCount: 2`
  - `changedFiles: 5`
- `autonomous-run`: `eval/results/autonomous-run/2026-04-30T23-46-19.905Z/`
  - `exitCode: 0`
  - `turnCount: 2`
  - `changedFiles: 5`
- `objective-memory-evidence`: exercised transitively by `autonomous-run` in this refresh
  - standalone artifact not refreshed separately in this batch
- `rollback`: `eval/results/rollback/2026-04-30T15-46-10.387Z/`
  - `exitCode: 0`
  - `turnCount: 3`
  - `changedFiles: 5`
