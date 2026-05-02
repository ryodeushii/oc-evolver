---
name: evolver-usage
description: Complete guide to using the OC-Evolver kernel for self-improvement through skills, agents, commands, and memory profiles
---

# OC-Evolver Kernel Usage Guide

This skill teaches you how to use the OC-Evolver kernel to create, manage, and evolve mutable OpenCode behavior artifacts. The kernel code is fixed — only the artifacts under `.opencode/` evolve through a controlled revision lifecycle.

## Artifact Types

The kernel manages four types of artifacts. Each is a Markdown document with YAML frontmatter.

### Skills

Reusable behavior injected into sessions. Stored as bundles under `.opencode/skills/<name>/`.

**Frontmatter schema:**
```yaml
---
name: <required, unique name>
description: <required, what this skill does>
memory: [<optional, list of memory profile names to load>]
---
```

**Body:** Instructions, workflows, or behavioral guidance that the agent follows when this skill is active.

**Helper files:** A skill bundle can include helper files (scripts, templates, reference docs) alongside `SKILL.md`. Paths must stay within the bundle directory.

**Example:**
```markdown
---
name: code-review
description: Systematic code review checklist and workflow
memory: [project-conventions]
---

When reviewing code, follow these steps:
1. Check for correctness and edge cases
2. Verify naming and style consistency
3. ...
```

### Agents

Reusable subagent or primary agent configurations. Stored as `.opencode/agent/<name>.md`.

**Frontmatter schema:**
```yaml
---
description: <required, what this agent does>
mode: <required: all | primary | subagent>
model: <optional, model override>
memory: [<optional, memory profile names>]
permission:
  <tool_name>: <allow | ask | deny>
---
```

**Body:** Agent instructions and behavior definition.

**Mode values:**
- `all` — works as both primary and subagent
- `primary` — only as the main session agent
- `subagent` — only when spawned as a subagent

### Commands

One-shot executable commands. Stored as `.opencode/commands/<name>.md`.

**Frontmatter schema:**
```yaml
---
description: <required, what this command does>
agent: <optional, agent name to run with>
model: <optional, model override>
memory: [<optional, memory profile names>]
permission:
  <tool_name>: <allow | ask | deny>
---
```

**Body:** Command instructions executed when the command is invoked.

### Memory Profiles

Durable knowledge and context routing. Stored as `.opencode/memory/<name>.md`.

**Frontmatter schema:**
```yaml
---
name: <required, unique name>
description: <required, what this memory contains>
storage_mode: <optional: memory-only | artifact-only | memory-and-artifact>
sources: [<optional, source patterns>]
queries: [<optional, query patterns>]
---
```

**Body:** Knowledge, preferences, conventions, or context that guides agent behavior.

**Storage modes:**
- `memory-only` — stored in Basic Memory only, no file artifact
- `artifact-only` — stored as file only, no Basic Memory entry
- `memory-and-artifact` — both (default when omitted)

## Revision Lifecycle

All mutations go through a revision system. You never write directly to the live artifact roots.

### 1. Write

Use the write tools to stage changes as a **pending revision**:

- `evolver_write_skill` — writes a skill bundle (name, document, optional helper files)
- `evolver_write_agent` — writes an agent document
- `evolver_write_command` — writes a command document
- `evolver_write_memory` — writes a memory profile

Each write creates or updates a pending revision. Multiple writes can accumulate in one revision.

### 2. Validate

Before promoting, validate your artifacts:

- `evolver_validate` with `scope: "document"` — validates a single document against its schema
- `evolver_validate` with `scope: "registry"` — validates all registered artifacts
- `evolver_check` — checks for invalid artifacts and pending revisions

### 3. Promote or Reject

- `evolver_promote` — promotes the pending revision to accepted (becomes the live state)
- `evolver_reject` — discards the pending revision, restoring the accepted state
- `evolver_rollback` — rolls back the latest accepted revision if it caused problems

### 4. Prune

- `evolver_prune` — removes obsolete revision snapshots to keep the registry clean

### 5. Delete

- `evolver_delete_artifact` — stages removal of a registered artifact (kind + name) as a pending revision

## Workflow Examples

### Creating a New Skill

```
1. evolver_write_skill(
     skillName: "my-skill",
     skillDocument: "---\nname: my-skill\ndescription: Does something useful\n---\n\nInstructions here..."
   )
2. evolver_validate(scope: "document", kind: "skill", document: "<the document>")
3. evolver_promote()
```

### Updating an Existing Skill

Same as creating — write with the same `skillName` to update. It becomes part of the pending revision.

### Creating an Agent

```
1. evolver_write_agent(
     agentName: "reviewer",
     document: "---\ndescription: Code review agent\nmode: subagent\n---\n\nReview code systematically..."
   )
2. evolver_promote()
```

### Creating a Memory Profile

```
1. evolver_write_memory(
     memoryName: "project-conventions",
     document: "---\nname: project-conventions\ndescription: Project coding conventions\n---\n\nAlways use TypeScript strict mode..."
   )
2. evolver_promote()
```

### Full Lifecycle with Validation

```
1. evolver_write_skill(skillName: "formatter", skillDocument: "...")
2. evolver_write_agent(agentName: "lint-bot", document: "...")
3. evolver_check()                    # verify no invalid artifacts
4. evolver_validate(scope: "registry") # validate all artifacts
5. evolver_promote()                   # promote both changes together
```

### Handling Validation Errors

If a write fails validation:
1. Read the error message — it tells you exactly which field is missing or invalid
2. Fix the document (e.g., add missing `name`, fix `mode` value, correct YAML syntax)
3. Re-write with `evolver_write_*`
4. Re-validate and promote

## Applying Artifacts to Sessions

Writing artifacts registers them. To use them in the current session:

- `evolver_apply_skill(skillName)` — injects a skill's instructions into the current session
- `evolver_apply_memory(memoryName)` — injects a memory profile into the current session
- `evolver_run_agent(agentName, prompt)` — runs an agent with a prompt
- `evolver_run_command(commandName, prompt)` — runs a command with a prompt

When you promote a revision with `hotLoad: true` on skills/memories, they are automatically applied to the current session.

## Autonomous Loop

The kernel includes a self-improvement engine that runs iterations autonomously.

### Configuration

Use `evolver_autonomous_configure` to set:

- `objectives` — array of `{prompt, priority, completionCriteria}` items
- `verificationCommands` — matrix of shell commands to run after each mutation
- `evaluationScenarios` — scenario names to validate against
- `intervalMs` — time between scheduled runs (0 = disabled)
- `failurePolicy` — `{maxConsecutiveFailures, escalationAction: "pause_loop" | "quarantine_objective"}`
- `enabled` / `paused` — control flags

### Control

- `evolver_autonomous_start` — activates scheduled execution
- `evolver_autonomous_pause` — pauses scheduling
- `evolver_autonomous_resume` — resumes after a pause
- `evolver_autonomous_stop` — hard-stops the worker and disables the loop
- `evolver_autonomous_run` — runs one iteration immediately (inline)
- `evolver_autonomous_preview` — shows what the next iteration would do (read-only)
- `evolver_autonomous_status` — shows current state, config, and worker info
- `evolver_autonomous_metrics` — shows success rates, timing, and objective stats

### How the Loop Works

1. **Select objective** — picks the highest-priority pending objective from the queue
2. **Mutate** — runs `opencode run` with the objective prompt in a continued session
3. **Verify** — runs verification commands (e.g., `bun run typecheck`, `bun run test:unit`)
4. **Evaluate** — runs evaluation scenarios if configured
5. **Decide:**
   - Pass → promote the revision
   - Fail → one bounded repair attempt, then reject
6. **Post-promotion health** — re-verify after promotion; rollback if regression detected
7. **Learn** — persist failure evidence, derive follow-up objectives

### Objective Sources

Objectives come from five sources:
- **Manual** — explicitly queued by the operator via `evolver_autonomous_configure`
- **Repair** — auto-derived from failed iterations
- **Invalid artifact** — auto-derived from detected invalid artifacts
- **Learning** — auto-derived from the latest failed prompt evidence
- **Health** — auto-derived from repeated recent failure patterns

## Inspection Tools

- `evolver_status` — shows the full registry (skills, agents, commands, memories, revisions)
- `evolver_check` — quick health check: invalid artifacts + pending revision status
- `evolver_review_pending` — shows details of the current pending revision

## Path Enforcement

The kernel enforces that all mutations stay within `.opencode/` mutable roots. Direct file writes to protected paths (like `opencode.json`, `package.json`) are blocked. Always use the evolver tools — they handle path validation, atomic writes, and revision tracking automatically.

## Best Practices

1. **Always validate before promoting** — use `evolver_check` or `evolver_validate` first
2. **Batch related changes** — write multiple artifacts before promoting for atomic revisions
3. **Use descriptive names** — skill/agent/command/memory names should be clear and unique
4. **Test with apply before promoting** — use `evolver_apply_skill` to verify behavior in-session
5. **Monitor autonomous metrics** — use `evolver_autonomous_metrics` to track loop health
6. **Prune regularly** — use `evolver_prune` to keep the registry clean after promotions
7. **Rollback on regression** — use `evolver_rollback` if a promoted change causes problems
