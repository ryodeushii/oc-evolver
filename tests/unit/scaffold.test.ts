import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import runtimeContract from "../../eval/runtime-contract.json"

describe("task 1 scaffold", () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "oc-evolver-scaffold-"))

    await mkdir(join(workspaceRoot, ".opencode/plugins"), { recursive: true })
    await writeFile(
      join(workspaceRoot, ".opencode/plugins/oc-evolver.ts"),
      "export const plugin = true\n",
    )
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  test("freezes the local runtime contract", () => {
    expect(runtimeContract.opencodeVersion).toBe("1.14.29")
    expect(runtimeContract.runFlags).toEqual([
      "--command",
      "--continue",
      "--session",
      "--fork",
      "--share",
      "--model",
      "--agent",
      "--format",
      "--file",
      "--attach",
      "--password",
      "--dir",
      "--port",
      "--variant",
      "--thinking",
      "--dangerously-skip-permissions",
    ])
    expect(runtimeContract.agentCreateFlags).toEqual([
      "--path",
      "--description",
      "--mode",
      "--permissions",
      "--model",
    ])
    expect(runtimeContract.nativeAgentDir).toBe("agent")
    expect(runtimeContract.pluginDir).toBe(".opencode/plugins")
    expect(runtimeContract.skillDir).toBe(".opencode/skills")
    expect(runtimeContract.commandDir).toBe(".opencode/commands")
  })

  test("exports a loadable plugin entry", async () => {
    const { OCEvolverPlugin } = await import("../../src/oc-evolver.ts")
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

    expect(hooks.tool).toBeDefined()
  })
})
