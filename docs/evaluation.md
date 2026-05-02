# Evaluation

## Overview

The evaluation harness runs OpenCode against a fresh temp workspace copied from `eval/fixtures/base/`. The bridge plugin file at `eval/fixtures/base/.opencode/plugins/oc-evolver.ts` is regenerated from the current repo source before each run.

Primary commands:

- `bun run eval:core`
- `bun run eval:pr`
- `bun run eval:autonomous-run`
- `bun run eval:smoke`
- `bun run eval:all`
- `bun run eval:installed-smoke`
- `bun run eval:installed-autonomous`
- `bun run scripts/run-eval.ts <scenario>`

Manual local verification:

- This plugin is intended to run inside a local `opencode` process, so the repo does not commit GitHub CI workflows for eval execution.
- Install the pinned local runtime first: Bun `1.3.13` and `opencode-ai@1.14.31`.
- Fast local gate set:
- `bun run typecheck`
- `bun run test:unit`
- `bun run scripts/check-runtime-contract.ts`
- `bun run eval:pr`
- `bun run eval:installed-autonomous`
- `bun run test:unit` intentionally targets `tests/unit` only. Installed-mode wrappers remain in `tests/integration` as helper coverage, but the authoritative installed-mode release proof is the direct `eval:installed-autonomous` run.
- Optional helper sweeps:
- `bun run eval:all`
- `bun run eval:installed-smoke`

Evaluation tiers:

### `core`

- Fast local proof batch.
- Scenarios:

- `smoke`
- `policy-deny`
- `autonomous-run`
- `autonomous-control`
- `autonomous-startup`

### `pr`

- Regular local batch.
- Includes everything in `core`, plus:

- `autonomous-preview`
- `autonomous-metrics`
- `autonomous-stop`

### `all`

- Optional helper sweep.
- Includes everything in `pr`, plus:

- `create-skill`
- `create-agent`
- `invalid-artifact`
- `memory-guided-write`
- `artifact-only-deny`
- `rollback`
- `objective-memory-evidence`

Additional targeted helper entrypoints still exist for direct debugging:

- `objective-memory-evidence`
- `autonomous-preview`
- `autonomous-metrics`
- `autonomous-stop`

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

- Targeted helper scenario kept under unit coverage instead of the regular live `eval:all` sweep because the current OpenCode runtime can leave the multi-turn skill/agent reuse flow without a clean harness completion boundary.
- Expected artifact signal under unit coverage:
  - four turns in `turns.json`
  - one shared continued session id after turn 1
  - persisted session state under `.opencode/oc-evolver/sessions/`
  - `README.md` changes from `TODO` to `NOTE`
  - audit sequence includes `write_skill`, `write_agent`, `apply_skill`, `run_agent`

### `command-runtime`

- Targeted helper scenario for command-owned runtime metadata, kept under unit coverage instead of the regular live `eval:all` sweep because the current OpenCode runtime can emit non-executable pseudo-tool markup for this prompt
- Expected artifact signal:
  - `.opencode/memory/session-routing.md`
  - `.opencode/memory/command-routing.md`
  - `.opencode/commands/review-markdown.md` with command-owned `model`, `memory`, and `permission` metadata
  - turn 1 executes exactly `evolver_run_command`
  - persisted session state under `.opencode/oc-evolver/sessions/` retains command-owned memory state
  - persisted runtime policy includes the command-owned memory/model/permission contract
  - audit sequence includes `run_command`

### `revision-lifecycle`

- Targeted helper scenario kept under unit coverage instead of the regular live `eval:all` sweep because the current OpenCode runtime can complete the revision lifecycle semantically while failing to hand the harness a clean live completion boundary.
- Expected artifact signal under unit coverage:
  - turn 1 executes exactly `evolver_write_command`
  - turn 2 executes exactly `evolver_promote`
  - turn 3 executes exactly `evolver_delete_artifact`
  - turn 4 executes exactly `evolver_review_pending`
  - turn 5 executes exactly `evolver_reject`
  - turn 6 executes exactly `evolver_prune`
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
  - the queued objective/configuration is preseeded in the temp fixture state before the run begins
  - turn 1 executes exactly `evolver_autonomous_start`
  - turn 1 does not use `evolver_autonomous_run` or outer-session mutating tools
  - turn 2 executes exactly `evolver_autonomous_status`
  - turn 3 executes exactly `evolver_status`
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

- Exercises the non-mutating control plane for configure, pause, resume, and status across four turns
- Expected artifact signal:
  - turn 1 executes exactly `evolver_autonomous_configure`
  - turn 2 executes exactly `evolver_autonomous_pause`
  - turn 3 executes exactly `evolver_autonomous_resume`
  - turn 4 executes exactly `evolver_autonomous_status`
  - `.opencode/oc-evolver/autonomous-loop.json` remains enabled, unpaused, and configured with `intervalMs: 60000`, `verificationCommands: [["bun", "run", "typecheck"]]`, `evaluationScenarios: ["autonomous-run"]`, and the required `pause_loop` failure policy
  - scheduled worker-mode restore can record only `skipped_unrunnable` iterations when no objectives are queued

### `autonomous-startup`

- Proves that persisted scheduled autonomous configuration restores at plugin startup before the model acts
- Expected artifact signal:
  - turn 1 executes exactly `evolver_autonomous_status`
  - turn 2 executes exactly `evolver_status`
  - `audit.ndjson` contains durable `autonomous_restore` evidence
  - status output reflects the restored enabled scheduled state with `intervalMs: 60000`
  - restored verification/evaluation settings remain `[ ["bun", "run", "typecheck"] ]` and `["autonomous-run"]`
  - startup may record a skipped iteration before the status reads when no bounded objective is runnable

### `objective-memory-evidence`

- Runs exactly two nested objective-evaluation turns as a status-only proof helper for `autonomous-run`
- Expected control-flow proof:
  - turn 1 calls exactly `evolver_autonomous_status`
  - turn 2 calls exactly `evolver_status`
  - it does not call any other tools
- Artifact note:
  - a standalone status check may still leave `.opencode/oc-evolver/registry.json` as the only durable artifact
  - this scenario is exercised transitively by `autonomous-run`
  - standalone runs can still be captured under `eval/results/objective-memory-evidence/` when needed

### `autonomous-preview`

- Runs exactly one read-only bounded preview check for the next autonomous iteration
- Expected control-flow proof:
  - turn 1 calls exactly `evolver_autonomous_preview`
  - turn 2 calls exactly `evolver_autonomous_status`
  - it does not call any mutating outer-session tools in either turn
- Expected artifact signal:
  - seeded `.opencode/oc-evolver/autonomous-loop.json` remains enabled and unpaused
  - preview output reports `wouldRun: true` for the queued bounded objective
  - preview output includes the selected objective prompt, its `manual` source, its rationale, and the merged verification/evaluation gates
  - status output still shows the same objective pending with no recorded iterations

### `autonomous-metrics`

- Runs exactly one read-only structured metrics check against persisted autonomous history
- Expected control-flow proof:
  - turn 1 calls exactly `evolver_autonomous_metrics`
  - turn 2 calls exactly `evolver_autonomous_status`
  - it does not call any mutating outer-session tools in either turn
- Expected artifact signal:
  - seeded `.opencode/oc-evolver/autonomous-loop.json` contains the persisted loop history
  - metrics output reports the expected iteration counts, promotion rate, duration summaries, and objective status counts
  - status output agrees on the derived quarantined/pending/pending objective mix and the promoted/rejected/skipped/rolled-back history

### `autonomous-stop`

- Runs exactly one stop-state control-plane check for a persisted scheduled autonomous loop
- Expected control-flow proof:
  - turn 1 calls exactly `evolver_autonomous_stop`
  - turn 2 calls exactly `evolver_autonomous_status`
  - it does not call any other tools in either turn
- Expected artifact signal:
  - `audit.ndjson` contains `autonomous_stop`
  - `.opencode/oc-evolver/autonomous-loop.json` ends disabled and paused with the original schedule and gates preserved
  - stop output reports `activation.mode: "stopped"`
  - status output reports the same disabled paused state with no recorded iterations

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
