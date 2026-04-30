# Evaluation

## Overview

The evaluation harness runs OpenCode against a fresh temp workspace copied from `eval/fixtures/base/`. The bridge plugin file at `eval/fixtures/base/.opencode/plugins/oc-evolver.ts` is regenerated from the current repo source before each run.

Primary commands:

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
  - `write_agent` audit event
  - registry entry under `agents`

### `reuse-skill`

- Multi-turn scenario split with `---` separators in `eval/scenarios/reuse-skill.md`
- Expected artifact signal:
  - four turns in `turns.json`
  - one shared continued session id after turn 1
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
| TypeScript | `bun run typecheck` | PASS | Clean `tsc --noEmit` run during Task 8 sweep |
| Unit tests | `bun run test:unit` | PASS | `37 pass`, `0 fail`, `119 expect()` |
| Smoke eval | `bun run eval:smoke` | PASS | Latest artifact: `eval/results/smoke/2026-04-30T02-18-38.092Z/` |
| Full eval suite | `bun run eval:all` | PASS | Latest scenario artifacts listed below |

## Latest full-sweep artifacts

- `smoke`: `eval/results/smoke/2026-04-30T02-18-38.092Z/`
  - `exitCode: 0`
  - `changedFiles: []`
- `create-skill`: `eval/results/create-skill/2026-04-30T02-18-52.837Z/`
  - `exitCode: 0`
  - changed files include `SKILL.md`, helper script, registry, audit, and revision snapshot
- `create-agent`: `eval/results/create-agent/2026-04-30T02-19-56.604Z/`
  - `exitCode: 0`
  - changed files include `.opencode/agent/fixture-reviewer.md`, registry, audit, and revision snapshot
- `reuse-skill`: `eval/results/reuse-skill/2026-04-30T02-20-56.318Z/`
  - `exitCode: 0`
  - `turnCount: 4`
  - changed files include skill bundle, agent, registry, audit, revision snapshots, and `README.md`
- `policy-deny`: `eval/results/policy-deny/2026-04-30T02-22-14.955Z/`
  - `exitCode: 0`
  - changed files include only `.opencode/oc-evolver/audit.ndjson`
- `invalid-artifact`: `eval/results/invalid-artifact/2026-04-30T02-22-43.919Z/`
  - `exitCode: 0`
  - changed files include audit, registry, and seeded invalid skill bundle

## Recent reference artifacts

These artifact directories were used to close Task 7 before the final sweep:

- `eval/results/reuse-skill/2026-04-30T16-10-00.000Z/`
- `eval/results/policy-deny/2026-04-30T17-00-00.000Z-policy-deny/`
- `eval/results/invalid-artifact/2026-04-30T17-00-00.000Z-invalid-artifact/`
