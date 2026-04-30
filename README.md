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

## Layout

- Kernel plugin entry: `src/oc-evolver.ts`
- Kernel support code: `src/kernel/*.ts`
- Frozen local runtime contract: `eval/runtime-contract.json`
- Fixture bridge plugin: `eval/fixtures/base/.opencode/plugins/oc-evolver.ts`
- Eval runner: `scripts/run-eval.ts`
- Scenario prompts: `eval/scenarios/*.md`
- Captured eval artifacts: `eval/results/<scenario>/<timestamp>/`

## Mutable roots

The kernel only allows autonomous writes inside these roots:

- `.opencode/oc-evolver/`
- `.opencode/skills/`
- `.opencode/agent/`
- `.opencode/commands/`

The local runtime contract is currently frozen to OpenCode `1.14.29` with native agent directory `agent/`.

## Protected paths

The kernel blocks autonomous edits to protected paths, including:

- `.opencode/plugins/**`
- `.opencode/opencode.json`
- `.opencode/opencode.jsonc`
- `.opencode/package.json`
- lockfiles

Protected-path denial is enforced both through `permission.ask` and through `tool.execute.before` for `apply_patch`, so the plugin still blocks kernel edits during eval runs that use `--dangerously-skip-permissions`.

## Kernel tools

The plugin exposes this stable v1 tool surface:

- `evolver_status`
- `evolver_validate`
- `evolver_write_skill`
- `evolver_write_agent`
- `evolver_write_command`
- `evolver_apply_skill`
- `evolver_run_agent`
- `evolver_rollback`

## Local commands

- Install dependencies: `bun install`
- Typecheck: `bun run typecheck`
- Unit tests: `bun run test:unit`
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
