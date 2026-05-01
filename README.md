# oc-evolver

`oc-evolver` is an OpenCode plugin that exposes a stable kernel for evolving mutable OpenCode behavior without allowing the model to rewrite the kernel itself.

## Install

To load the plugin directly from a GitHub URL, put the git dependency spec directly in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["git+https://github.com/<owner>/oc-evolver.git"]
}
```

OpenCode detects the package's `./server` export and installs it as a server plugin target.

Installed `./server` usage is intentionally global-only: mutable runtime state lives under `~/.config/opencode/oc-evolver/`, `~/.config/opencode/skills/`, `~/.config/opencode/agent/`, `~/.config/opencode/commands/`, and `~/.config/opencode/memory/`.

Eval fixtures still use workspace-local `.opencode/*` roots through explicit bridge files.

When the current workspace is the `oc-evolver` source repo itself, the plugin still uses the global OpenCode config root for mutable runtime state. Local development only relaxes protected-path checks so the kernel source can be edited in place.

## Layout

- Kernel plugin entry: `src/oc-evolver.ts`
- Kernel support code: `src/kernel/*.ts`
- Frozen local runtime contract: `eval/runtime-contract.json`
- Fixture bridge plugin: `eval/fixtures/base/.opencode/plugins/oc-evolver.ts`
- Eval runner: `scripts/run-eval.ts`
- Scenario prompts: `eval/scenarios/*.md`
- Captured eval artifacts: `eval/results/<scenario>/<timestamp>/`

## Mutable roots

The kernel only allows autonomous writes inside these roots relative to the active OpenCode config root:

- `.opencode/oc-evolver/`
- `.opencode/skills/`
- `.opencode/agent/`
- `.opencode/commands/`
- `.opencode/memory/`

The local runtime contract is currently frozen to OpenCode `1.14.29` with native agent directory `agent/`.

## Protected paths

The kernel blocks autonomous edits to protected paths, including:

- `.opencode/plugins/**`
- `.opencode/opencode.json`
- `.opencode/opencode.jsonc`
- `.opencode/package.json`
- lockfiles

Protected-path denial is enforced both through `permission.ask` and through `tool.execute.before` for mutating filesystem tools such as `write`, `edit`, `patch`, and `apply_patch`, so the plugin still blocks kernel edits during eval runs that use `--dangerously-skip-permissions`.

When the current workspace is the `oc-evolver` source repo itself, the plugin relaxes that self-protection so the agent can edit `src/oc-evolver.ts` and the rest of the kernel during local development. Installed/runtime usage keeps the normal protections.

## Kernel tools

The plugin exposes this stable v1 tool surface:

- `evolver_status`
- `evolver_check`
- `evolver_validate`
- `evolver_write_skill`
- `evolver_write_agent`
- `evolver_write_command`
- `evolver_write_memory`
- `evolver_apply_skill`
- `evolver_apply_memory`
- `evolver_autonomous_status`
- `evolver_autonomous_configure`
- `evolver_autonomous_start`
- `evolver_autonomous_pause`
- `evolver_autonomous_resume`
- `evolver_autonomous_run`
- `evolver_run_agent`
- `evolver_run_command`
- `evolver_delete_artifact`
- `evolver_prune`
- `evolver_promote`
- `evolver_reject`
- `evolver_rollback`

Mutable writes now land as pending revisions. In the interactive/operator flow, use `evolver_check` to see whether the registry is clean and whether a pending revision is still awaiting review, then use `evolver_promote` or `evolver_reject` to explicitly accept or discard that pending state.

The autonomous loop now has plugin-native control-plane tools. `evolver_autonomous_configure` persists queued objectives, verification commands, eval scenarios, schedule state, and a failure policy under the active OpenCode config root's `oc-evolver/autonomous-loop.json` (for example `.opencode/oc-evolver/autonomous-loop.json` in repo-backed/eval fixtures). The failure policy tracks consecutive objective failures and can either auto-pause the loop or quarantine the repeatedly failing objective after the configured threshold. `pause_loop` leaves `config.paused=true`, and subsequent runs surface `skipped_paused` until `evolver_autonomous_resume` clears that state. `quarantine_objective` changes the objective status to `quarantined`, which removes it from normal objective selection while leaving its escalation reason visible in status. `evolver_autonomous_start`, `evolver_autonomous_pause`, and `evolver_autonomous_resume` control scheduled workers through that persisted state, while `evolver_autonomous_run` executes one iteration immediately and `evolver_autonomous_status` reports the queue, latest learning, the most recent escalation reason, and recent iteration artifacts.

For a closed-loop path, `bun run autonomous:run` drives `opencode run` against the real repo, reuses the last continued session, persists richer loop learning plus iteration history under `.opencode/oc-evolver/autonomous-loop.json`, runs the default verification gates (`bun run typecheck`, `bun run test:unit`), runs the dedicated `autonomous-run` eval by default, and then auto-promotes, auto-rejects, or rolls back a newly accepted revision if post-promotion health regresses. Scheduled runs now use both a worker-local in-flight guard and a durable lock at `.opencode/oc-evolver/autonomous-loop.lock`. Pass `--worker` to keep that loop on a Worker-backed 15-minute schedule by default, or override the cadence with `--interval-ms <ms>`.

Commands are executable runtime artifacts rather than write-only markdown. `evolver_run_agent` and `evolver_run_command` now return structured execution records with the composed session response instead of only acknowledging that they ran. `evolver_run_command` composes command instructions with any referenced agent instructions, inherited memory profiles, runtime permission metadata, and preferred model guidance.

Lifecycle cleanup is also plugin-native: `evolver_delete_artifact` stages a deletion into a pending revision and removes the artifact from the working registry state, while `evolver_prune` removes obsolete revision snapshots that are no longer reachable from the accepted or pending revision graph.

Memory profiles are versioned markdown artifacts stored under `.opencode/memory/`. They steer session behavior by injecting Basic Memory routing guidance, optional `storage_mode`, and reusable source/query hints into skill and agent composition without copying the underlying Basic Memory note corpus into the kernel registry.

If a session applies a memory profile with `storage_mode: artifact-only`, the plugin denies Basic Memory mutation tools for that session through `tool.execute.before`.

## Local commands

- Install dependencies: `bun install`
- Typecheck: `bun run typecheck`
- Unit tests: `bun run test:unit`
- Autonomous loop: `bun run autonomous:run`
- Autonomous eval: `bun run eval:autonomous-run`
- Smoke eval: `bun run eval:smoke`
- Full eval suite: `bun run eval:all`

## Evaluation model

The eval harness always runs against a fresh temp workspace cloned from `eval/fixtures/base/`. It never targets the real user config tree.

Each scenario writes artifacts under `eval/results/<scenario>/<timestamp>/`, including:

- `result.json`
- `response.json`
- `stdout.txt`
- `stderr.txt`
- `turns.json` for multi-turn scenarios
- `audit.ndjson`
- `registry.json`

See `docs/evaluation.md` for scenario expectations and the latest pass matrix.
