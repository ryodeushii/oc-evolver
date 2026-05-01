import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import runtimeContract from "../../eval/runtime-contract.json"
import { OCEvolverPlugin } from "../../src/oc-evolver.ts"

describe("agent runtime", () => {
  let workspaceRoot: string
  let promptCalls: Array<unknown>

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "oc-evolver-agent-runtime-"))
    promptCalls = []

    await mkdir(join(workspaceRoot, ".opencode/plugins"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
    await writeFile(
      join(workspaceRoot, ".opencode/plugins/oc-evolver.ts"),
      "export const plugin = true\n",
    )
    await writeFile(
      join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
      JSON.stringify({
        skills: {},
        agents: {},
        commands: {},
        memories: {},
        quarantine: {},
        currentRevision: null,
        pendingRevision: null,
      }, null, 2),
    )
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
    mock.restore()
  })

  test("evolver_apply_skill injects the operator guide before the current skill bundle", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)
            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool?.evolver_write_skill?.execute(
      {
        skillName: "fixture-refactor",
        skillDocument: `---
name: fixture-refactor
description: Rewrite TODO markers in markdown files
---

Use the helper script.
`,
        helperFiles: [
          {
            relativePath: "scripts/rewrite.py",
            content: "print('rewrite')\n",
          },
        ],
      },
      {
        sessionID: "session-1",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_apply_skill?.execute(
      {
        skillName: "fixture-refactor",
      },
      {
        sessionID: "session-1",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(promptCalls).toHaveLength(2)
    expect(promptCalls[0]).toMatchObject({
      path: { id: "session-1" },
      body: {
        noReply: true,
      },
    })
    expect(JSON.stringify(promptCalls[0])).toContain("evolver_status")
    expect(JSON.stringify(promptCalls[0])).toContain("evolver_apply_memory")
    expect(JSON.stringify(promptCalls[0])).toContain("artifact-only")

    expect(promptCalls[1]).toMatchObject({
      path: { id: "session-1" },
      body: {
        noReply: true,
      },
    })
    expect(JSON.stringify(promptCalls[1])).toContain("fixture-refactor")
    expect(JSON.stringify(promptCalls[1])).toContain("scripts/rewrite.py")
    expect(JSON.stringify(promptCalls[1])).toContain("print('rewrite')")

    const auditLog = await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    expect(auditLog).toContain("apply_skill")
  })

  test("evolver_apply_memory injects a memory profile into the session with noReply", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)
            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool?.evolver_write_memory?.execute(
      {
        memoryName: "project-preferences",
        document: `---
name: project-preferences
description: Shared project memory routing
storage_mode: memory-and-artifact
sources:
  - memory://memory/config/global
  - memory://plans/oc-evolver/*
queries:
  - oc-evolver memory profile
---

Prefer Basic Memory notes for durable project guidance.
`,
      },
      {
        sessionID: "session-3",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_apply_memory?.execute(
      {
        memoryName: "project-preferences",
      },
      {
        sessionID: "session-3",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(promptCalls).toHaveLength(2)
    expect(JSON.stringify(promptCalls[0])).toContain("evolver_apply_memory")
    expect(promptCalls[1]).toMatchObject({
      path: { id: "session-3" },
      body: {
        noReply: true,
      },
    })
    expect(JSON.stringify(promptCalls[1])).toContain("project-preferences")
    expect(JSON.stringify(promptCalls[1])).toContain("memory://plans/oc-evolver/*")
    expect(JSON.stringify(promptCalls[1])).toContain("Prefer Basic Memory notes")

    const auditLog = await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    expect(auditLog).toContain("apply_memory")
  })

  test("evolver_run_agent composes the current agent prompt into a session reply", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)
            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool?.evolver_write_agent?.execute(
      {
        agentName: "fixture-reviewer",
        document: `---
description: Review markdown changes
mode: subagent
permission:
  edit: deny
---

Review markdown changes before they land.
`,
      },
      {
        sessionID: "session-2",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    const result = await hooks.tool?.evolver_run_agent?.execute(
      {
        agentName: "fixture-reviewer",
        prompt: "Review README.md and summarize the risk.",
      },
      {
        sessionID: "session-2",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(promptCalls).toHaveLength(2)
    expect(JSON.stringify(promptCalls[0])).toContain("evolver_run_agent")
    expect(promptCalls[1]).toMatchObject({
      path: { id: "session-2" },
      body: {
        parts: [{ type: "text", text: "Review README.md and summarize the risk." }],
      },
    })
    expect(JSON.stringify(promptCalls[1])).not.toContain("\"noReply\":true")
    expect(JSON.stringify(promptCalls[1])).toContain("fixture-reviewer")
    expect(JSON.stringify(promptCalls[1])).toContain("Review markdown changes before they land")
    expect(JSON.stringify(promptCalls[1])).toContain("Review README.md and summarize the risk")
    const agentResult = typeof result === "string" ? result : result?.output

    expect(JSON.parse(agentResult ?? "null")).toMatchObject({
      executionType: "agent",
      agentName: "fixture-reviewer",
      sessionID: "session-2",
      prompt: "Review README.md and summarize the risk.",
      response: {
        info: {},
        parts: [],
      },
    })

    const auditLog = await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    expect(auditLog).toContain("run_agent")
  })

  test("evolver_run_agent composes referenced memory profiles into the session reply", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)
            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool?.evolver_write_memory?.execute(
      {
        memoryName: "project-preferences",
        document: `---
name: project-preferences
description: Shared project memory routing
sources:
  - memory://plans/oc-evolver/*
queries:
  - oc-evolver memory profile
---

Review relevant memory before proposing durable behavior changes.
`,
      },
      {
        sessionID: "session-4",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_write_agent?.execute(
      {
        agentName: "fixture-reviewer",
        document: `---
description: Review markdown changes
mode: subagent
memory:
  - project-preferences
permission:
  edit: deny
---

Review markdown changes before they land.
`,
      },
      {
        sessionID: "session-4",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_run_agent?.execute(
      {
        agentName: "fixture-reviewer",
        prompt: "Review README.md and summarize the risk.",
      },
      {
        sessionID: "session-4",
        messageID: "message-3",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(promptCalls).toHaveLength(2)
    expect(JSON.stringify(promptCalls[0])).toContain("evolver_run_agent")
    expect(JSON.stringify(promptCalls[1])).toContain("project-preferences")
    expect(JSON.stringify(promptCalls[1])).toContain("memory://plans/oc-evolver/*")
    expect(JSON.stringify(promptCalls[1])).toContain("Review relevant memory before proposing durable behavior changes")
  })

  test("evolver_run_command composes command, agent, memory, and model guidance into the session reply", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)
            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool?.evolver_write_memory?.execute(
      {
        memoryName: "project-preferences",
        document: `---
name: project-preferences
description: Shared project memory routing
sources:
  - memory://plans/oc-evolver/*
---

Prefer durable project guidance.
`,
      },
      {
        sessionID: "session-5",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_write_agent?.execute(
      {
        agentName: "fixture-reviewer",
        document: `---
description: Review markdown changes
mode: subagent
memory:
  - project-preferences
permission:
  edit: deny
model: openai/gpt-5.4-mini
---

Review markdown changes before they land.
`,
      },
      {
        sessionID: "session-5",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_write_command?.execute(
      {
        commandName: "review-markdown",
        document: `---
description: Review markdown files
agent: fixture-reviewer
model: openai/gpt-5.4
---

Focus on correctness and risk.
`,
      },
      {
        sessionID: "session-5",
        messageID: "message-3",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    const result = await hooks.tool?.evolver_run_command?.execute(
      {
        commandName: "review-markdown",
        prompt: "Review README.md and summarize the risk.",
      },
      {
        sessionID: "session-5",
        messageID: "message-4",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(promptCalls).toHaveLength(2)
    expect(JSON.stringify(promptCalls[0])).toContain("evolver_run_agent")
    expect(promptCalls[1]).toMatchObject({
      path: { id: "session-5" },
      body: {
        parts: [{ type: "text", text: "Review README.md and summarize the risk." }],
      },
    })
    expect(JSON.stringify(promptCalls[1])).not.toContain("\"noReply\":true")
    expect(JSON.stringify(promptCalls[1])).toContain("Run command: review-markdown")
    expect(JSON.stringify(promptCalls[1])).toContain("fixture-reviewer")
    expect(JSON.stringify(promptCalls[1])).toContain("Review markdown changes before they land")
    expect(JSON.stringify(promptCalls[1])).toContain("Focus on correctness and risk")
    expect(JSON.stringify(promptCalls[1])).toContain("project-preferences")
    expect(JSON.stringify(promptCalls[1])).toContain("Preferred model: openai/gpt-5.4")
    expect(JSON.stringify(promptCalls[1])).toContain("Review README.md and summarize the risk")
    const commandResult = typeof result === "string" ? result : result?.output

    expect(JSON.parse(commandResult ?? "null")).toMatchObject({
      executionType: "command",
      commandName: "review-markdown",
      sessionID: "session-5",
      prompt: "Review README.md and summarize the risk.",
      response: {
        info: {},
        parts: [],
      },
    })

    const auditLog = await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")
    expect(auditLog).toContain("run_command")
  })

  test("evolver_run_command uses command-owned memory and permission metadata", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)
            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool?.evolver_write_memory?.execute(
      {
        memoryName: "command-preferences",
        document: `---
name: command-preferences
description: Command-owned memory routing
sources:
  - memory://plans/oc-evolver/*
---

Prefer command-owned guidance.
`,
      },
      {
        sessionID: "session-command-owned",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_write_command?.execute(
      {
        commandName: "review-markdown",
        document: `---
description: Review markdown files
model: openai/gpt-5.4
memory:
  - command-preferences
permission:
  edit: deny
---

Focus on correctness and risk.
`,
      },
      {
        sessionID: "session-command-owned",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_run_command?.execute(
      {
        commandName: "review-markdown",
        prompt: "Review README.md and summarize the risk.",
      },
      {
        sessionID: "session-command-owned",
        messageID: "message-3",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(promptCalls).toHaveLength(2)
    expect(JSON.stringify(promptCalls[1])).toContain("command-preferences")
    expect(JSON.stringify(promptCalls[1])).toContain("Prefer command-owned guidance")
    expect(JSON.stringify(promptCalls[1])).toContain("Preferred model: openai/gpt-5.4")

    const permissionOutput: { status: "ask" | "deny" | "allow" } = {
      status: "ask",
    }

    await hooks["permission.ask"]?.(
      {
        id: "perm-command-1",
        type: "edit",
        pattern: ".opencode/commands/review.md",
        sessionID: "session-command-owned",
        messageID: "message-4",
        title: "Edit file while command restricted",
        metadata: {},
        time: {
          created: Date.now(),
        },
      },
      permissionOutput,
    )

    expect(permissionOutput.status).toBe("deny")
  })

  test("evolver_run_command does not persist command-owned runtime state when the prompt fails", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)

            if (promptCalls.length > 1) {
              throw new Error("prompt failed")
            }

            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool?.evolver_write_memory?.execute(
      {
        memoryName: "command-preferences",
        document: `---
name: command-preferences
description: Command-owned memory routing
sources:
  - memory://plans/oc-evolver/*
---

Prefer command-owned guidance.
`,
      },
      {
        sessionID: "session-command-failure",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_write_command?.execute(
      {
        commandName: "review-markdown",
        document: `---
description: Review markdown files
memory:
  - command-preferences
permission:
  edit: deny
---

Focus on correctness and risk.
`,
      },
      {
        sessionID: "session-command-failure",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await expect(
      hooks.tool?.evolver_run_command?.execute(
        {
          commandName: "review-markdown",
          prompt: "Review README.md and summarize the risk.",
        },
        {
          sessionID: "session-command-failure",
          messageID: "message-3",
          agent: "main",
          directory: workspaceRoot,
          worktree: workspaceRoot,
          abort: new AbortController().signal,
          metadata() {},
          ask() {
            throw new Error("not implemented")
          },
        },
      ),
    ).rejects.toThrow("prompt failed")

    const permissionOutput: { status: "ask" | "deny" | "allow" } = {
      status: "ask",
    }

    await hooks["permission.ask"]?.(
      {
        id: "perm-command-failure-1",
        type: "edit",
        pattern: ".opencode/commands/review.md",
        sessionID: "session-command-failure",
        messageID: "message-4",
        title: "Edit file after failed command",
        metadata: {},
        time: {
          created: Date.now(),
        },
      },
      permissionOutput,
    )

    expect(permissionOutput.status).toBe("ask")

    const failedSessionState = JSON.parse(
      await readFile(
        join(
          workspaceRoot,
          ".opencode/oc-evolver/sessions",
          `${encodeURIComponent("session-command-failure")}.json`,
        ),
        "utf8",
      ),
    ) as {
      memories?: Record<string, unknown>
      runtimePolicy?: unknown
    }

    expect(failedSessionState.memories ?? {}).not.toHaveProperty("command-preferences")
    expect(failedSessionState.runtimePolicy).toBeUndefined()
  })

  test("evolver_run_command persists command-owned runtime policy across a fresh plugin instance", async () => {
    const firstHooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)
            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await firstHooks.tool?.evolver_write_command?.execute(
      {
        commandName: "review-markdown",
        document: `---
description: Review markdown files
permission:
  edit: deny
---

Focus on correctness and risk.
`,
      },
      {
        sessionID: "session-command-persisted",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await firstHooks.tool?.evolver_run_command?.execute(
      {
        commandName: "review-markdown",
        prompt: "Review README.md and summarize the risk.",
      },
      {
        sessionID: "session-command-persisted",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    const persistedSessionState = JSON.parse(
      await readFile(
        join(
          workspaceRoot,
          ".opencode/oc-evolver/sessions",
          `${encodeURIComponent("session-command-persisted")}.json`,
        ),
        "utf8",
      ),
    ) as {
      memories?: Record<string, { storageMode?: string }>
      runtimePolicy?: {
        sourceKind?: string
        sourceName?: string
        toolPermissions?: Record<string, string>
      }
    }

    expect(persistedSessionState.runtimePolicy).toMatchObject({
      sourceKind: "command",
      sourceName: "review-markdown",
      toolPermissions: {
        edit: "deny",
      },
    })

    const secondHooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async () => ({ info: {}, parts: [] }),
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    const permissionOutput: { status: "ask" | "deny" | "allow" } = {
      status: "ask",
    }

    await secondHooks["permission.ask"]?.(
      {
        id: "perm-command-persisted-1",
        type: "edit",
        pattern: ".opencode/commands/review.md",
        sessionID: "session-command-persisted",
        messageID: "message-3",
        title: "Edit file after resumed command session",
        metadata: {},
        time: {
          created: Date.now(),
        },
      },
      permissionOutput,
    )

    expect(permissionOutput.status).toBe("deny")
  })

  test("evolver_run_command applies command-owned permission policy during the command run itself", async () => {
    let hooks: Awaited<ReturnType<typeof OCEvolverPlugin>> | undefined

    hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async (payload: unknown) => {
            promptCalls.push(payload)

            if (promptCalls.length > 1) {
              const toolOutput: { status?: "ask" | "deny" | "allow" } = {
                status: "ask",
              }

              await hooks?.["permission.ask"]?.(
                {
                  id: "perm-command-inline-1",
                  type: "edit",
                  pattern: ".opencode/commands/review.md",
                  sessionID: "session-command-inline",
                  messageID: "message-inline-permission",
                  title: "Inline edit during command run",
                  metadata: {},
                  time: {
                    created: Date.now(),
                  },
                },
                toolOutput,
              )

              expect(toolOutput.status).toBe("deny")
            }

            return { info: {}, parts: [] }
          },
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: workspaceRoot,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool?.evolver_write_command?.execute(
      {
        commandName: "review-markdown",
        document: `---
description: Review markdown files
permission:
  edit: deny
---

Focus on correctness and risk.
`,
      },
      {
        sessionID: "session-command-inline",
        messageID: "message-1",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    await hooks.tool?.evolver_run_command?.execute(
      {
        commandName: "review-markdown",
        prompt: "Review README.md and summarize the risk.",
      },
      {
        sessionID: "session-command-inline",
        messageID: "message-2",
        agent: "main",
        directory: workspaceRoot,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )
  })
})
