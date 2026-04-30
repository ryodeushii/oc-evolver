import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { OCEvolverPlugin } from "../../src/oc-evolver.ts"

describe("plugin tool surface", () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "oc-evolver-plugin-tools-"))

    await mkdir(join(workspaceRoot, ".opencode/plugins"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
    await writeFile(
      join(workspaceRoot, ".opencode/plugins/oc-evolver.ts"),
      "export const plugin = true\n",
    )
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  test("registers the stable v1 kernel tool set", async () => {
    const hooks = await OCEvolverPlugin({
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

    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "evolver_apply_skill",
      "evolver_rollback",
      "evolver_run_agent",
      "evolver_status",
      "evolver_validate",
      "evolver_write_agent",
      "evolver_write_command",
      "evolver_write_skill",
    ])
  })

  test("denies protected plugin edits through permission.ask and records an audit event", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async () => ({ info: {}, parts: [] }),
        },
      },
      project: {
        id: "fixture-project",
        worktree: "/",
      },
      directory: workspaceRoot,
      worktree: "/",
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    const output: { status: "ask" | "deny" | "allow" } = {
      status: "ask",
    }

    await hooks["permission.ask"]?.(
      {
        id: "perm-1",
        type: "edit",
        pattern: ".opencode/plugins/oc-evolver.ts",
        sessionID: "session-1",
        messageID: "message-1",
        title: "Edit protected plugin",
        metadata: {},
        time: {
          created: Date.now(),
        },
      },
      output,
    )

    expect(output.status).toBe("deny")

    const auditLog = await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")

    expect(auditLog).toContain("policy_denied")
    expect(auditLog).toContain(".opencode/plugins/oc-evolver.ts")
  })

  test("denies protected plugin edits through tool.execute.before for apply_patch", async () => {
    const hooks = await OCEvolverPlugin({
      client: {
        session: {
          prompt: async () => ({ info: {}, parts: [] }),
        },
      },
      project: {
        id: "fixture-project",
        worktree: "/",
      },
      directory: workspaceRoot,
      worktree: "/",
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    const output = {
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: .opencode/plugins/oc-evolver.ts",
          "@@",
          '+console.log("hello")',
          "*** End Patch",
        ].join("\n"),
      },
    }

    await expect(
      hooks["tool.execute.before"]?.(
        {
          tool: "apply_patch",
          sessionID: "session-2",
          callID: "call-1",
        },
        output,
      ),
    ).rejects.toThrow(/protected path/i)

    const auditLog = await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")

    expect(auditLog).toContain("policy_denied")
    expect(auditLog).toContain(".opencode/plugins/oc-evolver.ts")
  })
})
