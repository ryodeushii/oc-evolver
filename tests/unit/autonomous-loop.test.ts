import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import runtimeContract from "../../eval/runtime-contract.json"
import {
  DEFAULT_AUTONOMOUS_LOOP_INTERVAL_MS,
  resolveAutonomousLoopSchedulePolicy,
  runAutonomousIteration,
  resolveAutonomousLoopStatePath,
  startAutonomousLoopWorker,
} from "../../src/kernel/autonomous-loop.ts"
import { applyMutationTransaction, loadRegistry } from "../../src/kernel/registry.ts"

describe("autonomous loop", () => {
  let repoRoot: string
  let pluginFilePath: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "oc-evolver-autonomous-loop-"))
    pluginFilePath = join(repoRoot, ".opencode/plugins/oc-evolver.ts")

    await mkdir(join(repoRoot, ".opencode/plugins"), { recursive: true })
    await writeFile(pluginFilePath, "export const plugin = true\n")
    await writeFile(join(repoRoot, "README.md"), "TODO: improve loop\n")
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test("promotes a pending revision after successful verification and evaluation and persists loop state", async () => {
    const commands: string[][] = []
    const evalScenarios: string[] = []

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      prompt: "Improve the README with the oc-evolver loop.",
      verificationCommands: [["bun", "run", "typecheck"], ["bun", "run", "test:unit"]],
      evaluationScenarios: ["smoke"],
      executeCommand: async ({ command }) => {
        commands.push(command)

        if (command[0] === "opencode") {
          await applyMutationTransaction({
            pluginFilePath,
            runtimeContract,
            mutation: {
              kind: "command",
              name: "autonomous-review",
              document: "---\ndescription: Autonomous review\n---\n\nReview autonomously.\n",
            },
          })

          return {
            stdout: '{"type":"step_start","sessionID":"session-1"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: `${command.join(" ")} ok\n`,
          stderr: "",
          exitCode: 0,
        }
      },
      runEvaluationScenario: async ({ scenarioName }) => {
        evalScenarios.push(scenarioName)

        return {
          scenarioName,
          resultDir: join(repoRoot, "eval-results", scenarioName),
          workspaceRoot: repoRoot,
          stdout: "eval ok\n",
          stderr: "",
          exitCode: 0,
          changedFiles: [],
        }
      },
    })

    const registry = await loadRegistry(pluginFilePath, runtimeContract)
    const loopState = JSON.parse(
      await readFile(resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract), "utf8"),
    ) as {
      lastSessionID: string | null
      latestLearning: string | null
      iterations: Array<{ decision: string; promotedRevisionID?: string | null }>
    }

    expect(result.decision).toBe("promoted")
    expect(result.sessionID).toBe("session-1")
    expect(commands[0]?.slice(0, 5)).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--dir",
    ])
    expect(commands[1]).toEqual(["bun", "run", "typecheck"])
    expect(commands[2]).toEqual(["bun", "run", "test:unit"])
    expect(evalScenarios).toEqual(["smoke"])
    expect(registry.currentRevision).toBeString()
    expect(registry.pendingRevision).toBeNull()
    expect(loopState.lastSessionID).toBe("session-1")
    expect(loopState.latestLearning).toContain("promoted")
    expect(loopState.iterations.at(-1)).toMatchObject({
      decision: "promoted",
      promotedRevisionID: registry.currentRevision,
    })
  })

  test("rejects a pending revision when verification fails and reuses the last session with learned context", async () => {
    const mutationPrompts: string[] = []
    const mutationCommands: string[][] = []
    let iterationNumber = 0

    const executeCommand = async ({ command }: { cwd: string; command: string[] }) => {
      if (command[0] === "opencode") {
        iterationNumber += 1
        mutationCommands.push(command)
        mutationPrompts.push(command.at(-1) ?? "")

        await applyMutationTransaction({
          pluginFilePath,
          runtimeContract,
          mutation: {
            kind: "command",
            name: "autonomous-review",
            document: `---\ndescription: Autonomous review ${iterationNumber}\n---\n\nReview autonomously.\n`,
          },
        })

        return {
          stdout: `{"type":"step_start","sessionID":"session-${iterationNumber}"}\n`,
          stderr: "",
          exitCode: 0,
        }
      }

      return {
        stdout: "",
        stderr: "verification failed",
        exitCode: 1,
      }
    }

    const first = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      prompt: "Attempt an autonomous improvement.",
      verificationCommands: [["bun", "run", "typecheck"]],
      executeCommand,
      runEvaluationScenario: async () => {
        throw new Error("evaluation should not run after verification failure")
      },
    })

    const second = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      prompt: "Attempt another autonomous improvement.",
      verificationCommands: [["bun", "run", "typecheck"]],
      executeCommand,
      runEvaluationScenario: async () => {
        throw new Error("evaluation should not run after verification failure")
      },
    })

    const registry = await loadRegistry(pluginFilePath, runtimeContract)
    const loopState = JSON.parse(
      await readFile(resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract), "utf8"),
    ) as {
      lastSessionID: string | null
      latestLearning: string | null
      iterations: Array<{ decision: string; rejectionReason?: string | null }>
    }

    expect(first.decision).toBe("rejected")
    expect(second.decision).toBe("rejected")
    expect(registry.currentRevision).toBeNull()
    expect(registry.pendingRevision).toBeNull()
    expect(loopState.lastSessionID).toBe("session-2")
    expect(loopState.latestLearning).toContain("verification failed")
    expect(loopState.iterations.at(-1)).toMatchObject({
      decision: "rejected",
      rejectionReason: expect.stringContaining("typecheck"),
    })
    expect(mutationCommands[1]).toContain("--session")
    expect(mutationCommands[1]).toContain("session-1")
    expect(mutationPrompts[1]).toContain("Previous autonomous-loop learning")
    expect(mutationPrompts[1]).toContain("verification failed")
  })

  test("starts scheduled execution through a worker boundary", () => {
    let receivedScript: URL | null = null
    let receivedOptions: { workerData?: unknown } | null = null

    const worker = startAutonomousLoopWorker(
      {
        repoRoot,
        pluginFilePath,
        prompt: "Keep improving the project.",
        intervalMs: 60_000,
        verificationCommands: [["bun", "run", "typecheck"]],
        evaluationScenarios: ["smoke"],
      },
      (scriptURL, options) => {
        receivedScript = scriptURL
        receivedOptions = options as { workerData?: unknown }

        return { on() {}, once() {}, terminate: async () => 0 } as never
      },
    )

    if (!receivedScript || !receivedOptions) {
      throw new Error("worker factory was not invoked")
    }

    const capturedScript = receivedScript as URL
    const capturedOptions = receivedOptions as { workerData?: unknown }

    expect(capturedScript.href).toContain("autonomous-loop-worker.ts")
    expect(capturedOptions.workerData).toMatchObject({
      repoRoot,
      pluginFilePath,
      prompt: "Keep improving the project.",
      intervalMs: 60_000,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: ["smoke"],
    })
    expect(worker).toBeDefined()
  })

  test("defaults explicit worker mode to a real recurring schedule", () => {
    expect(
      resolveAutonomousLoopSchedulePolicy({
        workerRequested: true,
        intervalMs: 0,
      }),
    ).toEqual({
      runInWorker: true,
      intervalMs: DEFAULT_AUTONOMOUS_LOOP_INTERVAL_MS,
    })
  })
})
