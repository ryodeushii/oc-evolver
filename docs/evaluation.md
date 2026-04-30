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
- `reuse-skill`
- `policy-deny`
- `invalid-artifact`
- `memory-guided-write`
- `artifact-only-deny`
- `autonomous-run`
- `rollback`

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
- Expected artifact signal:
  - `.opencode/oc-evolver/autonomous-loop.json`
  - `audit.ndjson` contains `promote`
  - `registry.json.currentRevision` is non-null
  - `autonomous-loop.json.latestLearning.summary` describes a promoted iteration

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

This section is updated from the latest full sweep artifacts.

| Check | Command | Status | Notes |
| --- | --- | --- | --- |
| TypeScript | `bun run typecheck` | PASS | Fresh clean `tsc --noEmit` run on current HEAD |
| Unit tests | `bun run test:unit` | PASS | `70 pass`, `0 fail`, `225 expect()` |
| Smoke eval | `bun run scripts/run-eval.ts smoke` | PASS | Latest artifact: `eval/results/smoke/2026-04-30T15-43-54.231Z/` |
| Full eval suite | Default scenario sweep | PASS | All default scenarios re-ran successfully; latest artifacts listed below |

## Latest full-sweep artifacts

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
- `autonomous-run`: pending refresh after the next full sweep
- `rollback`: `eval/results/rollback/2026-04-30T15-46-10.387Z/`
  - `exitCode: 0`
  - `turnCount: 3`
  - `changedFiles: 5`
