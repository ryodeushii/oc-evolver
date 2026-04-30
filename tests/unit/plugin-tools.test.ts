import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

  async function runBunEval(code: string) {
    const process = Bun.spawn(["bun", "--eval", code], {
      cwd: workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
    })

    const exitCode = await process.exited
    const stdout = await new Response(process.stdout).text()
    const stderr = await new Response(process.stderr).text()

    return { exitCode, stdout, stderr }
  }

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
      "evolver_apply_memory",
      "evolver_apply_skill",
      "evolver_rollback",
      "evolver_run_agent",
      "evolver_status",
      "evolver_validate",
      "evolver_write_agent",
      "evolver_write_command",
      "evolver_write_memory",
      "evolver_write_skill",
    ])

    expect(hooks.tool?.evolver_apply_memory?.description).toContain("memory profile")
    expect(hooks.tool?.evolver_rollback?.description).toContain("Rollback")
  })

  test("package root exposes the plugin server entrypoint", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    )

    expect(packageJson.exports?.["."]).toBe("./index.ts")
    expect(packageJson.exports?.["./server"]).toBe("./index.ts")

    const entrypoint = await import("../../index.ts")

    expect(typeof entrypoint.server).toBe("function")
    expect(entrypoint.OCEvolverPlugin).toBe(OCEvolverPlugin)
  })

  test("package ships the runtime contract needed by the server entrypoint", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { files?: string[] }

    expect(packageJson.files).toContain("eval/runtime-contract.json")
  })

  test("uses the bridge plugin path for global runtime roots", async () => {
    const projectRoot = join(workspaceRoot, "project")
    const globalOpencodeRoot = join(workspaceRoot, "global-opencode")
    const globalPluginFilePath = join(globalOpencodeRoot, "plugins/oc-evolver.ts")

    await mkdir(projectRoot, { recursive: true })
    await mkdir(join(globalOpencodeRoot, "plugins"), { recursive: true })
    await writeFile(globalPluginFilePath, "export const plugin = true\n")

    const pluginModule = await import("../../src/oc-evolver.ts")

    expect(typeof pluginModule.createOCEvolverPlugin).toBe("function")

    if (typeof pluginModule.createOCEvolverPlugin !== "function") {
      throw new Error("createOCEvolverPlugin export missing")
    }

    const hooks = await pluginModule.createOCEvolverPlugin(globalPluginFilePath)({
      client: {
        session: {
          prompt: async () => ({ info: {}, parts: [] }),
        },
      },
      project: {
        id: "fixture-project",
        worktree: projectRoot,
      },
      directory: projectRoot,
      worktree: projectRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.config?.({} as never)

    await access(join(globalOpencodeRoot, "oc-evolver"))
    await access(join(globalOpencodeRoot, "skills"))
    await access(join(globalOpencodeRoot, "agent"))
    await access(join(globalOpencodeRoot, "commands"))
    await access(join(globalOpencodeRoot, "memory"))

    await expect(access(join(projectRoot, ".opencode/oc-evolver"))).rejects.toBeDefined()
  })

  test("uses the registered global config root for package-installed plugins", async () => {
    const projectRoot = join(workspaceRoot, "project")
    const globalConfigHome = join(workspaceRoot, "xdg-config")
    const globalOpencodeRoot = join(globalConfigHome, "opencode")
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    const originalHome = process.env.HOME

    await mkdir(projectRoot, { recursive: true })
    await mkdir(globalOpencodeRoot, { recursive: true })
    await writeFile(
      join(globalOpencodeRoot, "opencode.jsonc"),
      JSON.stringify(
        {
          plugin: ["oc-evolver@git+https://github.com/ryodeushii/oc-evolver.git"],
        },
        null,
        2,
      ),
    )

    process.env.XDG_CONFIG_HOME = globalConfigHome
    process.env.HOME = workspaceRoot

    try {
      const hooks = await OCEvolverPlugin({
        client: {
          session: {
            prompt: async () => ({ info: {}, parts: [] }),
          },
        },
        project: {
          id: "fixture-project",
          worktree: projectRoot,
        },
        directory: projectRoot,
        worktree: projectRoot,
        experimental_workspace: {
          register() {},
        },
        serverUrl: new URL("http://localhost:4096"),
        $: {} as never,
      } as never)

      await hooks.config?.({} as never)

      await access(join(globalOpencodeRoot, "oc-evolver"))
      await access(join(globalOpencodeRoot, "skills"))
      await access(join(globalOpencodeRoot, "agent"))
      await access(join(globalOpencodeRoot, "commands"))
      await access(join(globalOpencodeRoot, "memory"))

      await expect(access(join(projectRoot, ".opencode/oc-evolver"))).rejects.toBeDefined()
    } finally {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
      process.env.HOME = originalHome
    }
  })

  test("bootstraps plugin-owned runtime directories during config", async () => {
    await rm(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true, force: true })

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

    await hooks.config?.({} as never)

    await access(join(workspaceRoot, ".opencode/oc-evolver"))
    await access(join(workspaceRoot, ".opencode/skills"))
    await access(join(workspaceRoot, ".opencode/agent"))
    await access(join(workspaceRoot, ".opencode/commands"))
    await access(join(workspaceRoot, ".opencode/memory"))

    expect(
      JSON.parse(
        await readFile(join(workspaceRoot, ".opencode/oc-evolver/registry.json"), "utf8"),
      ),
    ).toEqual({
      skills: {},
      agents: {},
      commands: {},
      memories: {},
      quarantine: {},
      currentRevision: null,
    })
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

  test("persists artifact-only memory policy across continued sessions", async () => {
    const firstRun = await runBunEval(`
      const { OCEvolverPlugin } = await import("file:///home/ryodeushii/repos/oc-evolver/src/oc-evolver.ts")
      const workspaceRoot = process.cwd()
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
        $: {},
      })

      await hooks.tool.evolver_write_memory.execute(
        {
          memoryName: "artifact-only-session",
          document: "---\\nname: artifact-only-session\\ndescription: Forbid Basic Memory writes for this session\\nstorage_mode: artifact-only\\n---\\n\\nRoute durable notes to repo artifacts only.\\n",
        },
        {
          sessionID: "session-persisted-artifact-only",
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

      await hooks.tool.evolver_apply_memory.execute(
        {
          memoryName: "artifact-only-session",
        },
        {
          sessionID: "session-persisted-artifact-only",
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

      console.log("applied")
    `)

    expect(firstRun.exitCode).toBe(0)
    expect(firstRun.stdout).toContain("applied")

    const secondRun = await runBunEval(`
      const { OCEvolverPlugin } = await import("file:///home/ryodeushii/repos/oc-evolver/src/oc-evolver.ts")
      const workspaceRoot = process.cwd()
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
        $: {},
      })

      try {
        await hooks["tool.execute.before"](
          {
            tool: "basic-memory_write_note",
            sessionID: "session-persisted-artifact-only",
            callID: "call-persisted-artifact-only",
          },
          {},
        )
        console.log("allowed")
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
    `)

    expect(secondRun.exitCode).toBe(1)
    expect(secondRun.stderr).toContain("artifact-only forbids Basic Memory writes")
    expect(secondRun.stdout).not.toContain("allowed")
  })

  test("allows source repo edits in an oc-evolver development workspace", async () => {
    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "oc-evolver" }, null, 2),
    )
    await writeFile(join(workspaceRoot, "src/oc-evolver.ts"), "export const dev = true\n")

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

    const output: { status: "ask" | "deny" | "allow" } = {
      status: "ask",
    }

    await hooks["permission.ask"]?.(
      {
        id: "perm-2",
        type: "edit",
        pattern: "src/oc-evolver.ts",
        sessionID: "session-3",
        messageID: "message-1",
        title: "Edit kernel source",
        metadata: {},
        time: {
          created: Date.now(),
        },
      },
      output,
    )

    expect(output.status).toBe("ask")

    await expect(
      hooks["tool.execute.before"]?.(
        {
          tool: "apply_patch",
          sessionID: "session-3",
          callID: "call-2",
        },
        {
          args: {
            patchText: [
              "*** Begin Patch",
              "*** Update File: src/oc-evolver.ts",
              "@@",
              '+export const changed = true',
              "*** End Patch",
            ].join("\n"),
          },
        },
      ),
    ).resolves.toBeUndefined()
  })

})
