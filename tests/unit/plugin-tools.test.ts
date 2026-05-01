import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

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
      "evolver_autonomous_configure",
      "evolver_autonomous_pause",
      "evolver_autonomous_resume",
      "evolver_autonomous_run",
      "evolver_autonomous_start",
      "evolver_autonomous_status",
      "evolver_check",
      "evolver_delete_artifact",
      "evolver_promote",
      "evolver_prune",
      "evolver_reject",
      "evolver_rollback",
      "evolver_run_agent",
      "evolver_run_command",
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

  test("autonomous start and resume activate the loop instead of only flipping persisted state", async () => {
    const activationCalls: Array<Record<string, unknown>> = []
    const activationDependencies: Array<Record<string, unknown>> = []
    const activationOptions: Array<Record<string, unknown> | undefined> = []
    const pluginModule = await import("../../src/oc-evolver.ts")

    const hooks = await (pluginModule.createOCEvolverPlugin as any)(undefined, {
      activateAutonomousLoop: async (
        input: Record<string, unknown>,
        dependencyOverrides: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        activationCalls.push(input)
        activationDependencies.push(dependencyOverrides)
        activationOptions.push(options)

        return {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 60_000,
            verificationCommands: [["bun", "run", "typecheck"]],
            evaluationScenarios: ["autonomous-run"],
          },
          lastSessionID: null,
          latestLearning: null,
          objectives: [],
          iterations: [],
          activation: {
            mode: "worker",
          },
          iteration: null,
        }
      },
    })({
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

    const toolCtx = {
      sessionID: "session-autonomous-control",
      messageID: "message-1",
      agent: "main",
      directory: workspaceRoot,
      worktree: workspaceRoot,
      abort: new AbortController().signal,
      metadata() {},
      ask() {
        throw new Error("not implemented")
      },
    }

    const start = JSON.parse(await hooks.tool.evolver_autonomous_start.execute({}, toolCtx))
    const resume = JSON.parse(await hooks.tool.evolver_autonomous_resume.execute({}, toolCtx))

    expect(activationCalls).toHaveLength(2)
    expect(activationCalls[0]).toMatchObject({
      repoRoot: workspaceRoot,
    })
    expect(typeof activationDependencies[0]?.runEvaluationScenario).toBe("function")
    expect(typeof activationDependencies[1]?.runEvaluationScenario).toBe("function")
    expect(activationOptions[0]).toEqual(undefined)
    expect(activationOptions[1]).toMatchObject({
      resumePaused: true,
    })
    expect(hooks.tool.evolver_autonomous_start.description).toContain("Activate")
    expect(hooks.tool.evolver_autonomous_resume.description).toContain("Activate")
    expect(start.config.enabled).toBe(true)
    expect(start.activation.mode).toBe("worker")
    expect(resume.activation.mode).toBe("worker")
  })

  test("autonomous evaluation runner falls back to the bundled eval harness when the worktree lacks one", async () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "")
    let evaluationInvocation: Record<string, unknown> | null = null
    const pluginModule = await import("../../src/oc-evolver.ts")

    const hooks = await (pluginModule.createOCEvolverPlugin as any)(undefined, {
      activateAutonomousLoop: async (
        _input: Record<string, unknown>,
        dependencyOverrides: Record<string, unknown>,
      ) => {
        const runEvaluationScenario = dependencyOverrides.runEvaluationScenario as (input: {
          repoRoot: string
          scenarioName: string
        }) => Promise<unknown>

        await runEvaluationScenario({
          repoRoot: workspaceRoot,
          scenarioName: "smoke",
        })

        return {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [],
            evaluationScenarios: ["smoke"],
            failurePolicy: {
              maxConsecutiveFailures: 3,
              escalationAction: "pause_loop",
              lastEscalationReason: null,
            },
          },
          lastSessionID: null,
          latestLearning: null,
          objectives: [],
          iterations: [],
          activation: {
            mode: "inline",
          },
          iteration: null,
        }
      },
      runEvaluationScenario: async (input: Record<string, unknown>) => {
        evaluationInvocation = input

        return {
          scenarioName: input.scenarioName,
          resultDir: join(repoRoot, "eval/results/smoke/fake"),
          workspaceRoot,
          stdout: "",
          stderr: "",
          exitCode: 0,
          changedFiles: [],
        }
      },
    })({
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

    await hooks.tool.evolver_autonomous_start.execute(
      {},
      {
        sessionID: "session-autonomous-eval",
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

    expect(evaluationInvocation).toMatchObject({
      repoRoot,
      scenarioName: "smoke",
    })
  })

  test("autonomous evaluation runner falls back to the bundled eval harness when the requested scenario is missing locally", async () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "")
    const localHarnessRoot = join(workspaceRoot, "local-harness")
    let evaluationInvocation: Record<string, unknown> | null = null
    const pluginModule = await import("../../src/oc-evolver.ts")

    await mkdir(join(localHarnessRoot, "scripts"), { recursive: true })
    await mkdir(join(localHarnessRoot, "eval/scenarios"), { recursive: true })
    await mkdir(join(localHarnessRoot, "eval/fixtures/base/.opencode/oc-evolver"), { recursive: true })
    await writeFile(join(localHarnessRoot, "scripts/run-eval.ts"), "export {}\n")
    await writeFile(join(localHarnessRoot, "eval/scenarios/smoke.md"), "Smoke scenario.\n")
    await writeFile(
      join(localHarnessRoot, "eval/fixtures/base/.opencode/oc-evolver/registry.json"),
      "{}\n",
    )

    const hooks = await (pluginModule.createOCEvolverPlugin as any)(undefined, {
      activateAutonomousLoop: async (
        _input: Record<string, unknown>,
        dependencyOverrides: Record<string, unknown>,
      ) => {
        const runEvaluationScenario = dependencyOverrides.runEvaluationScenario as (input: {
          repoRoot: string
          scenarioName: string
        }) => Promise<unknown>

        await runEvaluationScenario({
          repoRoot: localHarnessRoot,
          scenarioName: "objective-memory-evidence",
        })

        return {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [],
            evaluationScenarios: ["smoke"],
            failurePolicy: {
              maxConsecutiveFailures: 3,
              escalationAction: "pause_loop",
              lastEscalationReason: null,
            },
          },
          lastSessionID: null,
          latestLearning: null,
          objectives: [],
          iterations: [],
          activation: {
            mode: "inline",
          },
          iteration: null,
        }
      },
      runEvaluationScenario: async (input: Record<string, unknown>) => {
        evaluationInvocation = input

        return {
          scenarioName: input.scenarioName,
          resultDir: join(repoRoot, "eval/results/objective-memory-evidence/fake"),
          workspaceRoot,
          stdout: "",
          stderr: "",
          exitCode: 0,
          changedFiles: [],
        }
      },
    })({
      client: {
        session: {
          prompt: async () => ({ info: {}, parts: [] }),
        },
      },
      project: {
        id: "fixture-project",
        worktree: localHarnessRoot,
      },
      directory: localHarnessRoot,
      worktree: localHarnessRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool.evolver_autonomous_start.execute(
      {},
      {
        sessionID: "session-autonomous-missing-scenario",
        messageID: "message-1",
        agent: "main",
        directory: localHarnessRoot,
        worktree: localHarnessRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(evaluationInvocation).toMatchObject({
      repoRoot,
      scenarioName: "objective-memory-evidence",
    })
  })

  test("autonomous tool entrypoints prefer the active worktree when project worktree points at root", async () => {
    const activationCalls: Array<Record<string, unknown>> = []
    const pluginModule = await import("../../src/oc-evolver.ts")

    const hooks = await (pluginModule.createOCEvolverPlugin as any)(undefined, {
      activateAutonomousLoop: async (input: Record<string, unknown>) => {
        activationCalls.push(input)

        return {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [],
            evaluationScenarios: [],
            failurePolicy: {
              maxConsecutiveFailures: 3,
              escalationAction: "pause_loop",
              lastEscalationReason: null,
            },
          },
          lastSessionID: null,
          latestLearning: null,
          objectives: [],
          iterations: [],
          activation: {
            mode: "inline",
          },
          iteration: {
            decision: "no_pending_revision",
            sessionID: null,
            pendingRevisionID: null,
            promotedRevisionID: null,
            rejectionReason: null,
          },
        }
      },
    })({
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
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool.evolver_autonomous_start.execute(
      {},
      {
        sessionID: "session-autonomous-root-fallback",
        messageID: "message-root-fallback",
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

    expect(activationCalls).toHaveLength(1)
    expect(activationCalls[0]).toMatchObject({
      repoRoot: workspaceRoot,
    })
  })

  test("autonomous tool entrypoints prefer the active directory when worktree resolves to root", async () => {
    const activationCalls: Array<Record<string, unknown>> = []
    const pluginModule = await import("../../src/oc-evolver.ts")

    const hooks = await (pluginModule.createOCEvolverPlugin as any)(undefined, {
      activateAutonomousLoop: async (input: Record<string, unknown>) => {
        activationCalls.push(input)

        return {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [],
            evaluationScenarios: [],
            failurePolicy: {
              maxConsecutiveFailures: 3,
              escalationAction: "pause_loop",
              lastEscalationReason: null,
            },
          },
          lastSessionID: null,
          latestLearning: null,
          objectives: [],
          iterations: [],
          activation: {
            mode: "inline",
          },
          iteration: {
            decision: "no_pending_revision",
            sessionID: null,
            pendingRevisionID: null,
            promotedRevisionID: null,
            rejectionReason: null,
          },
        }
      },
    })({
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

    await hooks.tool.evolver_autonomous_start.execute(
      {},
      {
        sessionID: "session-autonomous-directory-fallback",
        messageID: "message-directory-fallback",
        agent: "main",
        directory: workspaceRoot,
        worktree: "/",
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(activationCalls).toHaveLength(1)
    expect(activationCalls[0]).toMatchObject({
      repoRoot: workspaceRoot,
    })
  })

  test("autonomous tool entrypoints keep the project worktree when directory is nested inside it", async () => {
    const activationCalls: Array<Record<string, unknown>> = []
    const pluginModule = await import("../../src/oc-evolver.ts")
    const nestedDirectory = join(workspaceRoot, "nested")

    await mkdir(nestedDirectory, { recursive: true })

    const hooks = await (pluginModule.createOCEvolverPlugin as any)(undefined, {
      activateAutonomousLoop: async (input: Record<string, unknown>) => {
        activationCalls.push(input)

        return {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [],
            evaluationScenarios: [],
            failurePolicy: {
              maxConsecutiveFailures: 3,
              escalationAction: "pause_loop",
              lastEscalationReason: null,
            },
          },
          lastSessionID: null,
          latestLearning: null,
          objectives: [],
          iterations: [],
          activation: {
            mode: "inline",
          },
          iteration: {
            decision: "no_pending_revision",
            sessionID: null,
            pendingRevisionID: null,
            promotedRevisionID: null,
            rejectionReason: null,
          },
        }
      },
    })({
      client: {
        session: {
          prompt: async () => ({ info: {}, parts: [] }),
        },
      },
      project: {
        id: "fixture-project",
        worktree: workspaceRoot,
      },
      directory: nestedDirectory,
      worktree: workspaceRoot,
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await hooks.tool.evolver_autonomous_start.execute(
      {},
      {
        sessionID: "session-autonomous-nested-directory",
        messageID: "message-nested-directory",
        agent: "main",
        directory: nestedDirectory,
        worktree: workspaceRoot,
        abort: new AbortController().signal,
        metadata() {},
        ask() {
          throw new Error("not implemented")
        },
      },
    )

    expect(activationCalls).toHaveLength(1)
    expect(activationCalls[0]).toMatchObject({
      repoRoot: workspaceRoot,
    })
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
      const entrypoint = await import("../../index.ts")

      const hooks = await entrypoint.server({
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

  test("server entrypoint uses the registered global config root even when a project bridge file exists", async () => {
    const projectRoot = join(workspaceRoot, "project")
    const globalConfigHome = join(workspaceRoot, "xdg-config")
    const globalOpencodeRoot = join(globalConfigHome, "opencode")
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    const originalHome = process.env.HOME

    await mkdir(join(projectRoot, ".opencode/plugins"), { recursive: true })
    await mkdir(globalOpencodeRoot, { recursive: true })
    await writeFile(
      join(projectRoot, ".opencode/plugins/oc-evolver.ts"),
      "export const plugin = true\n",
    )
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
      const entrypoint = await import("../../index.ts")

      const hooks = await entrypoint.server({
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
      pendingRevision: null,
    })
  })

  test("uses the global runtime roots in an oc-evolver development workspace", async () => {
    const globalConfigHome = join(workspaceRoot, "xdg-config")
    const globalOpencodeRoot = join(globalConfigHome, "opencode")
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    const originalHome = process.env.HOME

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await mkdir(globalOpencodeRoot, { recursive: true })
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "oc-evolver" }, null, 2),
    )
    await writeFile(join(workspaceRoot, "src/oc-evolver.ts"), "export const dev = true\n")
    await rm(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true, force: true })
    await rm(join(workspaceRoot, ".opencode/skills"), { recursive: true, force: true })
    await rm(join(workspaceRoot, ".opencode/agent"), { recursive: true, force: true })
    await rm(join(workspaceRoot, ".opencode/commands"), { recursive: true, force: true })
    await rm(join(workspaceRoot, ".opencode/memory"), { recursive: true, force: true })

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

      await access(join(globalOpencodeRoot, "oc-evolver"))
      await access(join(globalOpencodeRoot, "skills"))
      await access(join(globalOpencodeRoot, "agent"))
      await access(join(globalOpencodeRoot, "commands"))
      await access(join(globalOpencodeRoot, "memory"))

      await expect(access(join(workspaceRoot, ".opencode/oc-evolver"))).rejects.toBeDefined()
      await expect(access(join(workspaceRoot, ".opencode/skills"))).rejects.toBeDefined()
      await expect(access(join(workspaceRoot, ".opencode/agent"))).rejects.toBeDefined()
      await expect(access(join(workspaceRoot, ".opencode/commands"))).rejects.toBeDefined()
      await expect(access(join(workspaceRoot, ".opencode/memory"))).rejects.toBeDefined()
    } finally {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
      process.env.HOME = originalHome
    }
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

  test("does not let runtime write allow bypass protected-path denial in permission.ask", async () => {
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

    await hooks.tool?.evolver_write_agent?.execute(
      {
        agentName: "write-allowed-reviewer",
        document: `---
description: Allow writes in general
mode: subagent
permission:
  write: allow
---

Write files when needed.
`,
      },
      {
        sessionID: "session-write-allowed-agent",
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

    await hooks.tool?.evolver_run_agent?.execute(
      {
        agentName: "write-allowed-reviewer",
        prompt: "Write docs updates.",
      },
      {
        sessionID: "session-write-allowed-agent",
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

    const output: { status: "ask" | "deny" | "allow" } = {
      status: "ask",
    }

    await hooks["permission.ask"]?.(
      {
        id: "perm-write-allow-1",
        type: "write",
        pattern: ".opencode/plugins/oc-evolver.ts",
        sessionID: "session-write-allowed-agent",
        messageID: "message-3",
        title: "Write protected plugin",
        metadata: {},
        time: {
          created: Date.now(),
        },
      },
      output,
    )

    expect(output.status).toBe("deny")
  })

  test("denies protected plugin writes through tool.execute.before for write", async () => {
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

    await expect(
      hooks["tool.execute.before"]?.(
        {
          tool: "write",
          sessionID: "session-write-1",
          callID: "call-write-1",
        },
        {
          args: {
            file_path: ".opencode/plugins/oc-evolver.ts",
            content: 'console.log("hello")\n',
          },
        },
      ),
    ).rejects.toThrow(/protected path/i)

    const auditLog = await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")

    expect(auditLog).toContain("policy_denied")
    expect(auditLog).toContain(".opencode/plugins/oc-evolver.ts")
  })

  test("denies protected patch move destinations through tool.execute.before", async () => {
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

    await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
    await writeFile(join(workspaceRoot, ".opencode/commands/review.md"), "hello\n")

    await expect(
      hooks["tool.execute.before"]?.(
        {
          tool: "patch",
          sessionID: "session-patch-1",
          callID: "call-patch-1",
        },
        {
          args: {
            patch_text: [
              "*** Begin Patch",
              "*** Update File: .opencode/commands/review.md",
              "*** Move to: .opencode/plugins/oc-evolver.ts",
              "@@",
              "-hello",
              "+hello moved",
              "*** End Patch",
            ].join("\n"),
          },
        },
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

    expect(firstRun.exitCode, firstRun.stderr || firstRun.stdout).toBe(0)
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

  test("enforces agent permission metadata for continued session actions", async () => {
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

    await hooks.tool?.evolver_write_agent?.execute(
      {
        agentName: "restricted-reviewer",
        document: `---
description: Review without mutating files
mode: subagent
permission:
  edit: deny
---

Review only.
`,
      },
      {
        sessionID: "session-restricted-agent",
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

    await hooks.tool?.evolver_run_agent?.execute(
      {
        agentName: "restricted-reviewer",
        prompt: "Review README.md.",
      },
      {
        sessionID: "session-restricted-agent",
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

    const permissionOutput: { status: "ask" | "deny" | "allow" } = {
      status: "ask",
    }

    await hooks["permission.ask"]?.(
      {
        id: "perm-agent-1",
        type: "edit",
        pattern: ".opencode/commands/review.md",
        sessionID: "session-restricted-agent",
        messageID: "message-3",
        title: "Edit file while restricted",
        metadata: {},
        time: {
          created: Date.now(),
        },
      },
      permissionOutput,
    )

    expect(permissionOutput.status).toBe("deny")

    await expect(
      hooks["tool.execute.before"]?.(
        {
          tool: "apply_patch",
          sessionID: "session-restricted-agent",
          callID: "call-agent-1",
        },
        {
          args: {
            patchText: [
              "*** Begin Patch",
              "*** Update File: .opencode/commands/review.md",
              "@@",
              "+restricted edit",
              "*** End Patch",
            ].join("\n"),
          },
        },
      ),
    ).rejects.toThrow(/restricted-reviewer.*edit.*deny/i)
  })

  test("does not re-inject the operator guide when a continued session resumes in a fresh process", async () => {
    const firstRun = await runBunEval(`
      const { OCEvolverPlugin } = await import("file:///home/ryodeushii/repos/oc-evolver/src/oc-evolver.ts")
      const workspaceRoot = process.cwd()
      const prompts = []
      const hooks = await OCEvolverPlugin({
        client: {
          session: {
            prompt: async (payload) => {
              prompts.push(payload)
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
        $: {},
      })

      await hooks.tool.evolver_write_memory.execute(
        {
          memoryName: "guided-session-memory",
          document: "---\\nname: guided-session-memory\\ndescription: Persist operator guide state\\nstorage_mode: memory-only\\n---\\n\\nRoute durable notes to Basic Memory.\\n",
        },
        {
          sessionID: "session-guided-across-processes",
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
          memoryName: "guided-session-memory",
        },
        {
          sessionID: "session-guided-across-processes",
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

      console.log("promptCount=" + prompts.length)
    `);

    expect(firstRun.exitCode).toBe(0)
    expect(firstRun.stdout).toContain("promptCount=2")

    const secondRun = await runBunEval(`
      const { OCEvolverPlugin } = await import("file:///home/ryodeushii/repos/oc-evolver/src/oc-evolver.ts")
      const workspaceRoot = process.cwd()
      const prompts = []
      const hooks = await OCEvolverPlugin({
        client: {
          session: {
            prompt: async (payload) => {
              prompts.push(payload)
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
        $: {},
      })

      await hooks.tool.evolver_apply_memory.execute(
        {
          memoryName: "guided-session-memory",
        },
        {
          sessionID: "session-guided-across-processes",
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

      console.log("promptCount=" + prompts.length)
    `);

    expect(secondRun.exitCode).toBe(0)
    expect(secondRun.stdout).toContain("promptCount=1")
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
