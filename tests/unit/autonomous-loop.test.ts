import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import runtimeContract from "../../eval/runtime-contract.json"
import {
  activateAutonomousLoop,
  configureAutonomousLoop,
  DEFAULT_AUTONOMOUS_LOOP_INTERVAL_MS,
  DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS,
  getAutonomousLoopStatus,
  resolveAutonomousLoopSchedulePolicy,
  resolveAutonomousLoopLockPath,
  runAutonomousIteration,
  resolveAutonomousLoopStatePath,
  startAutonomousLoopWorker,
} from "../../src/kernel/autonomous-loop.ts"
import { applyMutationTransaction, loadRegistry, promotePendingRevision } from "../../src/kernel/registry.ts"

describe("autonomous loop", () => {
  let repoRoot: string
  let pluginFilePath: string

  const runtimeContractProbeResult = (command: string[]) => {
    if (command.join(" ") === "opencode --version") {
      return {
        stdout: `${runtimeContract.opencodeVersion}\n`,
        stderr: "",
        exitCode: 0,
      }
    }

    if (command.join(" ") === "opencode run --help") {
      return {
        stdout: runtimeContract.runFlags.join("\n"),
        stderr: "",
        exitCode: 0,
      }
    }

    if (command.join(" ") === "opencode agent create --help") {
      return {
        stdout: runtimeContract.agentCreateFlags.join("\n"),
        stderr: "",
        exitCode: 0,
      }
    }

    return null
  }

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

  test("configures autonomous objectives, dedupes them, and exposes loop status", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      intervalMs: 120_000,
      evaluationScenarios: ["autonomous-run"],
      objectives: [
        {
          prompt: "Review the registry lifecycle.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
        {
          prompt: "Review the registry lifecycle.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
        {
          prompt: "Harden autonomous scheduling.",
          completionCriteria: {
            evaluationScenarios: ["autonomous-run"],
          },
        },
      ],
      replaceObjectives: true,
      enabled: true,
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.config.enabled).toBe(true)
    expect(status.config.intervalMs).toBe(120_000)
    expect(status.config.evaluationScenarios).toEqual(["autonomous-run"])
    expect(status.objectives).toHaveLength(2)
    expect(status.objectives[0]).toMatchObject({
      prompt: "Review the registry lifecycle.",
      status: "pending",
      attempts: 0,
    })
    expect(status.objectives[1]).toMatchObject({
      prompt: "Harden autonomous scheduling.",
      status: "pending",
      attempts: 0,
    })
  })

  test("rejects objective configuration that does not provide explicit completion criteria", async () => {
    await expect(
      configureAutonomousLoop({
        pluginFilePath,
        runtimeContract,
        replaceObjectives: true,
        objectives: [
          {
            prompt: "Ship the command once someone decides it is done.",
          },
        ],
      }),
    ).rejects.toThrow(/explicit completion criteria/i)
  })

  test("rejects failure-policy thresholds that are not positive integers", async () => {
    await expect(
      configureAutonomousLoop({
        pluginFilePath,
        runtimeContract,
        failurePolicy: {
          maxConsecutiveFailures: 0,
        },
      }),
    ).rejects.toThrow(/maxConsecutiveFailures/i)
  })

  test("preserves an explicitly empty global evaluation scenario list across reload", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      evaluationScenarios: [],
      replaceObjectives: true,
      objectives: [],
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.config.evaluationScenarios).toEqual([])
  })

  test("preserves an explicitly empty verification command list across reload", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      verificationCommands: [],
      replaceObjectives: true,
      objectives: [],
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.config.verificationCommands).toEqual([])
  })

  test("drops persisted legacy objectives that do not define explicit completion criteria", async () => {
    await mkdir(join(repoRoot, ".opencode", "oc-evolver"), { recursive: true })
    await writeFile(
      resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract),
      `${JSON.stringify(
        {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [["bun", "run", "typecheck"]],
            evaluationScenarios: [],
          },
          lastSessionID: "legacy-session",
          latestLearning: {
            summary: "Legacy objective already complete.",
            remainingObjectives: [],
          },
          objectives: [
            {
              prompt: "Legacy shallow objective",
              status: "completed",
              completionCriteria: null,
              lastCompletionEvidence: null,
              attempts: 1,
              updatedAt: new Date(0).toISOString(),
              lastSessionID: "legacy-session",
              lastDecision: "promoted",
            },
          ],
          iterations: [],
        },
        null,
        2,
      )}\n`,
    )

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.objectives).toEqual([])
  })

  test("downgrades persisted completed objectives when explicit completion evidence is missing", async () => {
    await mkdir(join(repoRoot, ".opencode", "oc-evolver"), { recursive: true })
    await writeFile(
      resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract),
      `${JSON.stringify(
        {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [["bun", "run", "typecheck"]],
            evaluationScenarios: [],
          },
          lastSessionID: "legacy-session",
          latestLearning: null,
          objectives: [
            {
              prompt: "Legacy completed objective without evidence",
              status: "completed",
              completionCriteria: {
                changedArtifacts: ["command:autonomous-review"],
              },
              lastCompletionEvidence: null,
              attempts: 1,
              updatedAt: new Date(0).toISOString(),
              lastSessionID: "legacy-session",
              lastDecision: "promoted",
            },
          ],
          iterations: [],
        },
        null,
        2,
      )}\n`,
    )

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.objectives).toMatchObject([
      {
        prompt: "Legacy completed objective without evidence",
        status: "pending",
      },
    ])
  })

  test("downgrades persisted completed objectives when stored satisfied evidence does not match the criteria", async () => {
    await mkdir(join(repoRoot, ".opencode", "oc-evolver"), { recursive: true })
    await writeFile(
      resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract),
      `${JSON.stringify(
        {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [["bun", "run", "typecheck"]],
            evaluationScenarios: [],
          },
          lastSessionID: "legacy-session",
          latestLearning: null,
          objectives: [
            {
              prompt: "Legacy completed objective with bogus evidence",
              status: "completed",
              completionCriteria: {
                changedArtifacts: ["command:autonomous-review"],
                evaluationScenarios: ["objective-proof"],
              },
              lastCompletionEvidence: {
                satisfied: true,
                changedArtifacts: ["command:some-other-command"],
                passedEvaluationScenarios: ["autonomous-run"],
                missingChangedArtifacts: [],
                missingEvaluationScenarios: [],
                checkedAt: new Date(0).toISOString(),
              },
              attempts: 1,
              updatedAt: new Date(0).toISOString(),
              lastSessionID: "legacy-session",
              lastDecision: "promoted",
            },
          ],
          iterations: [],
        },
        null,
        2,
      )}\n`,
    )

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.objectives).toMatchObject([
      {
        prompt: "Legacy completed objective with bogus evidence",
        status: "pending",
      },
    ])
    expect(status.latestLearning?.remainingObjectives).toContain(
      "Legacy completed objective with bogus evidence",
    )
  })

  test("preserves objective completion when equivalent criteria are reconfigured in a different order", async () => {
    await mkdir(join(repoRoot, ".opencode", "oc-evolver"), { recursive: true })
    await writeFile(
      resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract),
      `${JSON.stringify(
        {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [["bun", "run", "typecheck"]],
            evaluationScenarios: [],
          },
          lastSessionID: "legacy-session",
          latestLearning: null,
          objectives: [
            {
              prompt: "Stable completed objective",
              status: "completed",
              completionCriteria: {
                changedArtifacts: ["command:b", "command:a"],
                evaluationScenarios: ["scenario-b", "scenario-a"],
              },
              lastCompletionEvidence: {
                satisfied: true,
                changedArtifacts: ["command:a", "command:b"],
                passedEvaluationScenarios: ["scenario-a", "scenario-b"],
                missingChangedArtifacts: [],
                missingEvaluationScenarios: [],
                checkedAt: new Date(0).toISOString(),
              },
              attempts: 1,
              updatedAt: new Date(0).toISOString(),
              lastSessionID: "legacy-session",
              lastDecision: "promoted",
            },
          ],
          iterations: [],
        },
        null,
        2,
      )}\n`,
    )

    const status = await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      objectives: [
        {
          prompt: "Stable completed objective",
          completionCriteria: {
            changedArtifacts: ["command:a", "command:b"],
            evaluationScenarios: ["scenario-a", "scenario-b"],
          },
        },
      ],
    })

    expect(status.objectives).toMatchObject([
      {
        prompt: "Stable completed objective",
        status: "completed",
      },
    ])
  })

  test("keeps an objective pending when promotion succeeds without satisfying explicit completion criteria", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      objectives: [
        {
          prompt: "Ship the autonomous review command only after the target skill changes.",
          completionCriteria: {
            changedArtifacts: ["skill:target-skill"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-evidence-missing"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "ok\n",
          stderr: "",
          exitCode: 0,
        }
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.objectives).toHaveLength(1)
    expect(status.objectives[0]).toMatchObject({
      prompt: "Ship the autonomous review command only after the target skill changes.",
      status: "pending",
      lastDecision: "promoted",
    })
    expect(status.objectives[0]?.lastCompletionEvidence).toMatchObject({
      satisfied: false,
      changedArtifacts: ["command:autonomous-review"],
      missingChangedArtifacts: ["skill:target-skill"],
    })
    expect(status.latestLearning?.remainingObjectives).toContain(
      "Ship the autonomous review command only after the target skill changes.",
    )
  })

  test("marks an objective completed once a promoted iteration satisfies its explicit completion criteria", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      objectives: [
        {
          prompt: "Complete the review command rollout when the command artifact exists.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-evidence-hit"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "ok\n",
          stderr: "",
          exitCode: 0,
        }
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.objectives).toHaveLength(1)
    expect(status.objectives[0]).toMatchObject({
      prompt: "Complete the review command rollout when the command artifact exists.",
      status: "completed",
      lastDecision: "promoted",
    })
    expect(status.objectives[0]?.lastCompletionEvidence).toMatchObject({
      satisfied: true,
      changedArtifacts: ["command:autonomous-review"],
      missingChangedArtifacts: [],
    })
    expect(status.latestLearning?.remainingObjectives).toEqual([])
  })

  test("marks an objective completed when its required evaluation scenario passes", async () => {
    const evalScenarios: string[] = []

    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      evaluationScenarios: ["autonomous-run"],
      objectives: [
        {
          prompt: "Complete once the objective-proof scenario passes.",
          completionCriteria: {
            evaluationScenarios: ["objective-proof"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"]],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-eval-proof"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "ok\n",
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

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(evalScenarios).toEqual(["autonomous-run", "objective-proof"])
    expect(status.objectives[0]).toMatchObject({
      prompt: "Complete once the objective-proof scenario passes.",
      status: "completed",
    })
    expect(status.objectives[0]?.lastCompletionEvidence).toMatchObject({
      satisfied: true,
      passedEvaluationScenarios: ["autonomous-run", "objective-proof"],
      missingEvaluationScenarios: [],
    })
  })

  test("marks an objective completed when its required verification command passes", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      evaluationScenarios: [],
      objectives: [
        {
          prompt: "Complete once typecheck passes during the autonomous iteration.",
          completionCriteria: {
            verificationCommands: [["bun", "run", "typecheck"]],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-verification-proof"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "typecheck ok\n",
          stderr: "",
          exitCode: 0,
        }
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.objectives[0]).toMatchObject({
      prompt: "Complete once typecheck passes during the autonomous iteration.",
      status: "completed",
    })
    expect(status.objectives[0]?.lastCompletionEvidence).toMatchObject({
      satisfied: true,
      passedVerificationCommands: [["bun", "run", "typecheck"]],
      missingVerificationCommands: [],
    })
  })

  test("records verification and evaluation diagnostics in iteration history", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      evaluationScenarios: [],
      objectives: [
        {
          prompt: "Capture verification and evaluation diagnostics.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: ["objective-proof"],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-diagnostics"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "typecheck ok\n",
          stderr: "warning: none\n",
          exitCode: 0,
        }
      },
      runEvaluationScenario: async ({ scenarioName }) => {
        return {
          scenarioName,
          resultDir: join(repoRoot, "eval-results", scenarioName),
          workspaceRoot: repoRoot,
          stdout: "eval ok\n",
          stderr: "eval stderr\n",
          exitCode: 0,
          changedFiles: ["README.md"],
        }
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.iterations.at(-1)?.verification).toEqual([
      {
        command: ["bun", "run", "typecheck"],
        exitCode: 0,
        stdout: "typecheck ok\n",
        stderr: "warning: none\n",
      },
    ])
    expect(status.iterations.at(-1)?.evaluations).toEqual([
      {
        scenarioName: "objective-proof",
        exitCode: 0,
        stdout: "eval ok\n",
        stderr: "eval stderr\n",
        changedFiles: ["README.md"],
      },
    ])
  })

  test("preserves actual artifact evidence when a later verification step rejects the iteration", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      objectives: [
        {
          prompt: "Track whether the autonomous review command was actually changed.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"], ["bun", "run", "test:unit"]],
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-rejected-evidence"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "verification failed\n",
          stderr: "",
          exitCode: command.at(-1) === "test:unit" ? 1 : 0,
        }
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.objectives[0]).toMatchObject({
      prompt: "Track whether the autonomous review command was actually changed.",
      status: "pending",
      lastDecision: "rejected",
    })
    expect(status.objectives[0]?.lastCompletionEvidence).toMatchObject({
      satisfied: false,
      changedArtifacts: ["command:autonomous-review"],
      missingChangedArtifacts: [],
    })
  })

  test("records a structured failed evaluation entry when a scenario throws", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      evaluationScenarios: [],
      objectives: [
        {
          prompt: "Complete once the objective-proof scenario succeeds.",
          completionCriteria: {
            evaluationScenarios: ["objective-proof"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"]],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-eval-throw"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "ok\n",
          stderr: "",
          exitCode: 0,
        }
      },
      runEvaluationScenario: async ({ scenarioName }) => {
        if (scenarioName !== "objective-proof") {
          throw new Error(`unexpected scenario: ${scenarioName}`)
        }

        throw new Error("scenario boom")
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.iterations.at(-1)?.evaluations).toEqual([
      {
        scenarioName: "objective-proof",
        exitCode: 1,
        stdout: "",
        stderr: "scenario boom",
        changedFiles: [],
      },
      {
        scenarioName: "objective-proof",
        exitCode: 1,
        stdout: "",
        stderr: "scenario boom",
        changedFiles: [],
      },
    ])
  })

  test("quarantines a repeatedly failing objective after the configured threshold", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      failurePolicy: {
        maxConsecutiveFailures: 2,
        escalationAction: "quarantine_objective",
      },
      objectives: [
        {
          prompt: "Quarantine this flaky objective after repeated rejection.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
      ],
    })

    const rejectingIteration = async () => {
      await runAutonomousIteration({
        repoRoot,
        pluginFilePath,
        runtimeContract,
        verificationCommands: [["bun", "run", "typecheck"]],
        evaluationScenarios: [],
        executeCommand: async ({ command }) => {
          const probeResult = runtimeContractProbeResult(command)

          if (probeResult) {
            return probeResult
          }

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
              stdout: '{"type":"step_start","sessionID":"session-quarantine"}\n',
              stderr: "",
              exitCode: 0,
            }
          }

          return {
            stdout: "verification failed\n",
            stderr: "",
            exitCode: 1,
          }
        },
      })
    }

    await rejectingIteration()
    await rejectingIteration()

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.config.paused).toBe(false)
    expect(status.config.failurePolicy.lastEscalationReason).toContain(
      "Quarantine this flaky objective after repeated rejection.",
    )
    expect(status.objectives[0]).toMatchObject({
      prompt: "Quarantine this flaky objective after repeated rejection.",
      status: "quarantined",
      consecutiveFailures: 2,
    })
    expect(status.objectives[0]?.lastEscalationReason).toContain(
      "Quarantine this flaky objective after repeated rejection.",
    )
  })

  test("pauses the loop after a repeatedly failing objective exceeds the configured threshold", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      failurePolicy: {
        maxConsecutiveFailures: 2,
        escalationAction: "pause_loop",
      },
      objectives: [
        {
          prompt: "Pause the loop when this objective keeps failing.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
      ],
    })

    const rejectingIteration = async () => {
      await runAutonomousIteration({
        repoRoot,
        pluginFilePath,
        runtimeContract,
        verificationCommands: [["bun", "run", "typecheck"]],
        evaluationScenarios: [],
        executeCommand: async ({ command }) => {
          const probeResult = runtimeContractProbeResult(command)

          if (probeResult) {
            return probeResult
          }

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
              stdout: '{"type":"step_start","sessionID":"session-paused"}\n',
              stderr: "",
              exitCode: 0,
            }
          }

          return {
            stdout: "verification failed\n",
            stderr: "",
            exitCode: 1,
          }
        },
      })
    }

    await rejectingIteration()
    await rejectingIteration()

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.config.paused).toBe(true)
    expect(status.config.failurePolicy.lastEscalationReason).toContain(
      "Pause the loop when this objective keeps failing.",
    )
    expect(status.objectives[0]).toMatchObject({
      prompt: "Pause the loop when this objective keeps failing.",
      status: "pending",
      consecutiveFailures: 2,
    })
    expect(status.objectives[0]?.lastEscalationReason).toContain(
      "Pause the loop when this objective keeps failing.",
    )

    const executedCommands: string[][] = []
    const blocked = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

        executedCommands.push(command)

        return {
          stdout: "unexpected\n",
          stderr: "",
          exitCode: 0,
        }
      },
    })

    expect(blocked.decision).toBe("skipped_paused")
    expect(executedCommands).toEqual([])
  })

  test("clears stale global escalation state after a later successful recovery", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      failurePolicy: {
        maxConsecutiveFailures: 1,
        escalationAction: "quarantine_objective",
      },
      objectives: [
        {
          prompt: "Escalate once, then recover on a later objective.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-stale-escalation"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "verification failed\n",
          stderr: "",
          exitCode: 1,
        }
      },
    })

    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      objectives: [
        {
          prompt: "Recover with a successful completion.",
          completionCriteria: {
            changedArtifacts: ["command:autonomous-review"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
            stdout: '{"type":"step_start","sessionID":"session-recovered"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "ok\n",
          stderr: "",
          exitCode: 0,
        }
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.config.failurePolicy.lastEscalationReason).toBeNull()
    expect(status.latestLearning?.summary).not.toContain("exceeded 1 consecutive failures")
  })

  test("skips the iteration before mutation when evaluation scenarios are configured without an evaluator", async () => {
    const executedCommands: string[][] = []

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      evaluationScenarios: ["autonomous-run"],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

        executedCommands.push(command)

        return {
          stdout: "unexpected\n",
          stderr: "",
          exitCode: 0,
        }
      },
    })

    const registry = await loadRegistry(pluginFilePath, runtimeContract)

    expect(result).toMatchObject({
      decision: "skipped_unrunnable",
      sessionID: null,
    })
    expect(result.rejectionReason).toContain("runEvaluationScenario")
    expect(executedCommands).toEqual([])
    expect(registry.pendingRevision).toBeNull()
  })

  test("does not count missing evaluators as objective failures toward escalation", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      replaceObjectives: true,
      failurePolicy: {
        maxConsecutiveFailures: 1,
        escalationAction: "pause_loop",
      },
      objectives: [
        {
          prompt: "Do not escalate this objective for control-plane misconfiguration.",
          completionCriteria: {
            evaluationScenarios: ["objective-proof"],
          },
        },
      ],
    })

    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      evaluationScenarios: ["objective-proof"],
    })
    await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      evaluationScenarios: ["objective-proof"],
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(status.config.paused).toBe(false)
    expect(status.config.failurePolicy.lastEscalationReason).toBeNull()
    expect(status.objectives[0]).toMatchObject({
      prompt: "Do not escalate this objective for control-plane misconfiguration.",
      status: "pending",
      attempts: 0,
      consecutiveFailures: 0,
    })
  })

  test("does not attach a stale session to pre-mutation evaluator rejection", async () => {
    await mkdir(join(repoRoot, ".opencode", "oc-evolver"), { recursive: true })
    await writeFile(
      resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract),
      `${JSON.stringify(
        {
          config: {
            enabled: true,
            paused: false,
            intervalMs: 0,
            verificationCommands: [["bun", "run", "typecheck"]],
            evaluationScenarios: [],
          },
          lastSessionID: "session-legacy",
          latestLearning: null,
          objectives: [],
          iterations: [],
        },
        null,
        2,
      )}\n`,
    )

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      evaluationScenarios: ["autonomous-run"],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

        throw new Error("mutation should not run without an evaluator")
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(result.sessionID).toBeNull()
    expect(status.lastSessionID).toBe("session-legacy")
  })

  test("skips the iteration before mutation when the live opencode version drifts from the frozen runtime contract", async () => {
    const executedCommands: string[][] = []

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      executeCommand: async ({ command }) => {
        executedCommands.push(command)

        if (command.join(" ") === "opencode --version") {
          return {
            stdout: "1.99.0\n",
            stderr: "",
            exitCode: 0,
          }
        }

        throw new Error(`unexpected command: ${command.join(" ")}`)
      },
    })

    expect(result.decision).toBe("skipped_unrunnable")
    expect(result.sessionID).toBeNull()
    expect(result.rejectionReason).toContain(runtimeContract.opencodeVersion)
    expect(result.rejectionReason).toContain("1.99.0")
    expect(executedCommands).toEqual([["opencode", "--version"]])
  })

  test("skips the iteration before mutation when required runtime-contract flags are missing", async () => {
    const executedCommands: string[][] = []

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      executeCommand: async ({ command }) => {
        executedCommands.push(command)

        if (command.join(" ") === "opencode --version") {
          return {
            stdout: `${runtimeContract.opencodeVersion}\n`,
            stderr: "",
            exitCode: 0,
          }
        }

        if (command.join(" ") === "opencode run --help") {
          return {
            stdout: runtimeContract.runFlags.filter((flag) => flag !== "--dangerously-skip-permissions").join("\n"),
            stderr: "",
            exitCode: 0,
          }
        }

        if (command.join(" ") === "opencode agent create --help") {
          return {
            stdout: runtimeContract.agentCreateFlags.join("\n"),
            stderr: "",
            exitCode: 0,
          }
        }

        throw new Error(`unexpected command: ${command.join(" ")}`)
      },
    })

    expect(result.decision).toBe("skipped_unrunnable")
    expect(result.rejectionReason).toContain("opencode run")
    expect(result.rejectionReason).toContain("--dangerously-skip-permissions")
    expect(executedCommands).toEqual([
      ["opencode", "--version"],
      ["opencode", "run", "--help"],
      ["opencode", "agent", "create", "--help"],
    ])
  })

  test("skips the iteration before mutation when required agent-create runtime-contract flags are missing", async () => {
    const executedCommands: string[][] = []

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      executeCommand: async ({ command }) => {
        executedCommands.push(command)

        if (command.join(" ") === "opencode --version") {
          return {
            stdout: `${runtimeContract.opencodeVersion}\n`,
            stderr: "",
            exitCode: 0,
          }
        }

        if (command.join(" ") === "opencode run --help") {
          return {
            stdout: runtimeContract.runFlags.join("\n"),
            stderr: "",
            exitCode: 0,
          }
        }

        if (command.join(" ") === "opencode agent create --help") {
          return {
            stdout: runtimeContract.agentCreateFlags.filter((flag) => flag !== "--model").join("\n"),
            stderr: "",
            exitCode: 0,
          }
        }

        throw new Error(`unexpected command: ${command.join(" ")}`)
      },
    })

    expect(result.decision).toBe("skipped_unrunnable")
    expect(result.rejectionReason).toContain("opencode agent create")
    expect(result.rejectionReason).toContain("--model")
    expect(executedCommands).toEqual([
      ["opencode", "--version"],
      ["opencode", "run", "--help"],
      ["opencode", "agent", "create", "--help"],
    ])
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
      evaluationScenarios: DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS,
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

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
      latestLearning: { summary: string; remainingObjectives: string[] } | null
      iterations: Array<{
        decision: string
        promotedRevisionID?: string | null
        verification: Array<{ command: string[]; exitCode: number }>
        evaluations: Array<{ scenarioName: string; exitCode: number }>
        changedArtifacts: string[]
      }>
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
    expect(commands[0]).toContain("--dangerously-skip-permissions")
    expect(commands[1]).toEqual(["bun", "run", "typecheck"])
    expect(commands[2]).toEqual(["bun", "run", "test:unit"])
    expect(evalScenarios).toEqual(DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS)
    expect(registry.currentRevision).toBeString()
    expect(registry.pendingRevision).toBeNull()
    expect(loopState.lastSessionID).toBe("session-1")
    expect(loopState.latestLearning?.summary).toContain("promoted")
    expect(loopState.iterations.at(-1)).toMatchObject({
      decision: "promoted",
      promotedRevisionID: registry.currentRevision,
      verification: [
        { command: ["bun", "run", "typecheck"], exitCode: 0 },
        { command: ["bun", "run", "test:unit"], exitCode: 0 },
      ],
      evaluations: DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS.map((scenarioName) => ({
        scenarioName,
        exitCode: 0,
      })),
    })
    expect(loopState.iterations.at(-1)?.changedArtifacts).toContain("command:autonomous-review")
  })

  test("rejects a pending revision when verification fails and reuses the last session with learned context", async () => {
    const mutationPrompts: string[] = []
    const mutationCommands: string[][] = []
    let iterationNumber = 0

    const executeCommand = async ({ command }: { cwd: string; command: string[] }) => {
      const probeResult = runtimeContractProbeResult(command)

      if (probeResult) {
        return probeResult
      }

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
      latestLearning: { summary: string } | null
      iterations: Array<{ decision: string; rejectionReason?: string | null }>
    }

    expect(first.decision).toBe("rejected")
    expect(second.decision).toBe("rejected")
    expect(registry.currentRevision).toBeNull()
    expect(registry.pendingRevision).toBeNull()
    expect(loopState.lastSessionID).toBe("session-4")
    expect(loopState.latestLearning?.summary).toContain("verification failed")
    expect(loopState.iterations.at(-1)).toMatchObject({
      decision: "rejected",
      rejectionReason: expect.stringContaining("typecheck"),
    })
    expect(mutationCommands[2]).toContain("--session")
    expect(mutationCommands[2]).toContain("session-2")
    expect(mutationPrompts[2]).toContain("Previous autonomous-loop learning")
    expect(mutationPrompts[2]).toContain("verification failed")
  })

  test("repairs a failed verification pass before rejecting the iteration", async () => {
    const mutationPrompts: string[] = []
    const mutationCommands: string[][] = []
    let mutationNumber = 0
    let verificationNumber = 0

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      prompt: "Fix the autonomous review command until typecheck passes.",
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

        if (command[0] === "opencode") {
          mutationNumber += 1
          mutationCommands.push(command)
          mutationPrompts.push(command.at(-1) ?? "")

          await applyMutationTransaction({
            pluginFilePath,
            runtimeContract,
            mutation: {
              kind: "command",
              name: "autonomous-review",
              document: `---\ndescription: Autonomous review ${mutationNumber}\n---\n\nReview autonomously.\n`,
            },
          })

          return {
            stdout: `{"type":"step_start","sessionID":"session-repair-${mutationNumber}"}\n`,
            stderr: "",
            exitCode: 0,
          }
        }

        verificationNumber += 1

        return verificationNumber === 1
          ? {
              stdout: "typecheck failed\n",
              stderr: "repair me",
              exitCode: 1,
            }
          : {
              stdout: "typecheck ok\n",
              stderr: "",
              exitCode: 0,
            }
      },
      runEvaluationScenario: async () => {
        throw new Error("evaluation should not run in this test")
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(result.decision).toBe("promoted")
    expect(mutationCommands).toHaveLength(2)
    expect(mutationCommands[1]).toContain("--session")
    expect(mutationCommands[1]).toContain("session-repair-1")
    expect(mutationPrompts[1]).toContain("Repair the last autonomous attempt")
    expect(mutationPrompts[1]).toContain("bun run typecheck failed: repair me")
    expect(status.iterations.at(-1)).toMatchObject({
      decision: "promoted",
      sessionID: "session-repair-2",
    })
    expect(status.iterations.at(-1)?.verification).toEqual([
      {
        command: ["bun", "run", "typecheck"],
        exitCode: 1,
        stdout: "typecheck failed\n",
        stderr: "repair me",
      },
      {
        command: ["bun", "run", "typecheck"],
        exitCode: 0,
        stdout: "typecheck ok\n",
        stderr: "",
      },
    ])
  })

  test("rejects after one bounded repair attempt still fails", async () => {
    const mutationPrompts: string[] = []
    let mutationNumber = 0

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      prompt: "Keep trying the autonomous review command.",
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

        if (command[0] === "opencode") {
          mutationNumber += 1
          mutationPrompts.push(command.at(-1) ?? "")

          await applyMutationTransaction({
            pluginFilePath,
            runtimeContract,
            mutation: {
              kind: "command",
              name: "autonomous-review",
              document: `---\ndescription: Autonomous review ${mutationNumber}\n---\n\nReview autonomously.\n`,
            },
          })

          return {
            stdout: `{"type":"step_start","sessionID":"session-bounded-${mutationNumber}"}\n`,
            stderr: "",
            exitCode: 0,
          }
        }

        return {
          stdout: "still failing\n",
          stderr: "same verification error",
          exitCode: 1,
        }
      },
      runEvaluationScenario: async () => {
        throw new Error("evaluation should not run after verification failure")
      },
    })

    const status = await getAutonomousLoopStatus({
      pluginFilePath,
      runtimeContract,
    })

    expect(result.decision).toBe("rejected")
    expect(mutationPrompts).toHaveLength(2)
    expect(mutationPrompts[1]).toContain("Repair the last autonomous attempt")
    expect(status.iterations.at(-1)).toMatchObject({
      decision: "rejected",
      sessionID: "session-bounded-2",
      rejectionReason: expect.stringContaining("same verification error"),
    })
    expect(status.iterations.at(-1)?.verification).toHaveLength(2)
  })

  test("starts scheduled execution through a worker boundary", () => {
    let receivedScript: URL | null = null
    let receivedOptions: { workerData?: unknown } | null = null

    const worker = startAutonomousLoopWorker(
      {
        repoRoot,
        pluginFilePath,
        intervalMs: 60_000,
        verificationCommands: [["bun", "run", "typecheck"]],
        evaluationScenarios: ["autonomous-run"],
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
      intervalMs: 60_000,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: ["autonomous-run"],
    })
    expect(worker).toBeDefined()
  })

  test("activates recurring execution through a worker when the configured schedule repeats", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      intervalMs: 60_000,
      evaluationScenarios: ["autonomous-run"],
      enabled: true,
      paused: false,
    })

    let receivedWorkerConfig: Record<string, unknown> | null = null
    let inlineRuns = 0

    const result = await activateAutonomousLoop(
      {
        repoRoot,
        pluginFilePath,
        runtimeContract,
      },
      {
        startWorker(config) {
          receivedWorkerConfig = config as Record<string, unknown>

          return {
            once() {
              return this
            },
          } as never
        },
        async runIteration() {
          inlineRuns += 1

          return {
            decision: "no_pending_revision",
            sessionID: null,
            pendingRevisionID: null,
            promotedRevisionID: null,
            rejectionReason: null,
          }
        },
      },
    )

    expect(result.activation.mode).toBe("worker")
    expect(result.config).toMatchObject({
      enabled: true,
      paused: false,
      intervalMs: 60_000,
    })
    expect(receivedWorkerConfig).toMatchObject({
      repoRoot,
      pluginFilePath,
      intervalMs: 60_000,
      evaluationScenarios: ["autonomous-run"],
    })
    expect(inlineRuns).toBe(0)
  })

  test("does not spawn a duplicate worker when the same schedule is activated twice", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      intervalMs: 60_000,
      evaluationScenarios: ["autonomous-run"],
      enabled: true,
      paused: false,
    })

    let workerStarts = 0

    const startWorker = () => {
      workerStarts += 1

      return {
        once() {
          return this
        },
        terminate: async () => 0,
      } as never
    }

    const first = await activateAutonomousLoop(
      {
        repoRoot,
        pluginFilePath,
        runtimeContract,
      },
      {
        startWorker,
      },
    )
    const second = await activateAutonomousLoop(
      {
        repoRoot,
        pluginFilePath,
        runtimeContract,
      },
      {
        startWorker,
      },
    )

    expect(first.activation.mode).toBe("worker")
    expect(second.activation.mode).toBe("worker_already_running")
    expect(workerStarts).toBe(1)
  })

  test("restarts the active worker when scheduling config changes", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      intervalMs: 60_000,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: ["autonomous-run"],
      enabled: true,
      paused: false,
    })

    const startedConfigs: Array<Record<string, unknown>> = []
    let terminatedWorkers = 0

    const startWorker = (config: Record<string, unknown>) => {
      startedConfigs.push(config)

      return {
        once() {
          return this
        },
        terminate: async () => {
          terminatedWorkers += 1
          return 0
        },
      } as never
    }

    await activateAutonomousLoop(
      {
        repoRoot,
        pluginFilePath,
        runtimeContract,
      },
      {
        startWorker,
      },
    )

    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      intervalMs: 120_000,
      verificationCommands: [["bun", "run", "test:unit"]],
      evaluationScenarios: ["autonomous-run", "rollback"],
      enabled: true,
      paused: false,
    })

    const restarted = await activateAutonomousLoop(
      {
        repoRoot,
        pluginFilePath,
        runtimeContract,
      },
      {
        startWorker,
      },
    )

    expect(restarted.activation.mode).toBe("worker")
    expect(terminatedWorkers).toBe(1)
    expect(startedConfigs).toHaveLength(2)
    expect(startedConfigs[1]).toMatchObject({
      intervalMs: 120_000,
      verificationCommands: [["bun", "run", "test:unit"]],
      evaluationScenarios: ["autonomous-run", "rollback"],
    })
  })

  test("runs one inline iteration when recurring scheduling is disabled", async () => {
    await configureAutonomousLoop({
      pluginFilePath,
      runtimeContract,
      intervalMs: 0,
      evaluationScenarios: [],
      enabled: true,
      paused: false,
    })

    let inlineRunInput: Record<string, unknown> | null = null
    let workerStarts = 0

    const result = await activateAutonomousLoop(
      {
        repoRoot,
        pluginFilePath,
        runtimeContract,
      },
      {
        runEvaluationScenario: async ({ scenarioName }) => ({
          scenarioName,
          resultDir: join(repoRoot, "eval-results", scenarioName),
          workspaceRoot: repoRoot,
          stdout: "eval ok\n",
          stderr: "",
          exitCode: 0,
          changedFiles: [],
        }),
        startWorker() {
          workerStarts += 1

          return {
            once() {
              return this
            },
          } as never
        },
        async runIteration(input) {
          inlineRunInput = input as unknown as Record<string, unknown>

          return {
            decision: "no_pending_revision",
            sessionID: "session-inline",
            pendingRevisionID: null,
            promotedRevisionID: null,
            rejectionReason: "nothing to promote",
          }
        },
      },
    )

    expect(result.activation.mode).toBe("inline")
    expect(result.config).toMatchObject({
      enabled: true,
      paused: false,
      intervalMs: 0,
    })
    expect(result.iteration).toMatchObject({
      decision: "no_pending_revision",
      sessionID: "session-inline",
    })
    expect(inlineRunInput).toMatchObject({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      verificationCommands: [["bun", "run", "typecheck"], ["bun", "run", "test:unit"]],
      evaluationScenarios: [],
    })
    expect(typeof (inlineRunInput as { runEvaluationScenario?: unknown } | null)?.runEvaluationScenario).toBe("function")
    expect(workerStarts).toBe(0)
  })

  test("skips a new iteration when the loop lock is already held", async () => {
    await mkdir(resolveAutonomousLoopLockPath(pluginFilePath, runtimeContract), { recursive: true })
    const executedCommands: string[][] = []

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      prompt: "Try to improve the loop.",
      executeCommand: async ({ command }) => {
        executedCommands.push(command)

        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
        }
      },
    })

    expect(result.decision).toBe("skipped_locked")
    expect(executedCommands).toEqual([])
    expect(result.rejectionReason).toContain("lock")
  })

  test("rolls back a promoted revision when post-promotion verification regresses an accepted state", async () => {
    const first = await applyMutationTransaction({
      pluginFilePath,
      runtimeContract,
      mutation: {
        kind: "command",
        name: "autonomous-review",
        document: `---
description: First autonomous review flow
---

Review README.md once.
`,
      },
    })
    await promotePendingRevision(pluginFilePath, runtimeContract)

    let verificationRuns = 0

    const result = await runAutonomousIteration({
      repoRoot,
      pluginFilePath,
      runtimeContract,
      prompt: "Improve the autonomous review command.",
      evaluationScenarios: [],
      executeCommand: async ({ command }) => {
        const probeResult = runtimeContractProbeResult(command)

        if (probeResult) {
          return probeResult
        }

        if (command[0] === "opencode") {
          await applyMutationTransaction({
            pluginFilePath,
            runtimeContract,
            mutation: {
              kind: "command",
              name: "autonomous-review",
              document: `---
description: Second autonomous review flow
---

Review README.md twice.
`,
            },
          })

          return {
            stdout: '{"sessionID":"session-rollback"}\n',
            stderr: "",
            exitCode: 0,
          }
        }

        verificationRuns += 1

        return {
          stdout: verificationRuns > 2 ? "regressed after promote" : "verification ok",
          stderr: "",
          exitCode: verificationRuns > 2 ? 1 : 0,
        }
      },
    })

    const registry = await loadRegistry(pluginFilePath, runtimeContract)

    expect(result.decision).toBe("rolled_back")
    expect(result.promotedRevisionID).not.toBeNull()
    expect(result.rejectionReason).toContain("post-promotion verification failed")
    expect(registry.currentRevision).toBe(first.revisionID)
    expect(registry.pendingRevision).toBeNull()
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
