import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Worker, type WorkerOptions } from "node:worker_threads"

import { ensureKernelRuntimePaths, loadRegistry, promotePendingRevision, rejectPendingRevision, validateRegistryArtifacts } from "./registry.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"

export type AutonomousLoopCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type AutonomousLoopDecision = "mutation_failed" | "no_pending_revision" | "promoted" | "rejected"

export type AutonomousLoopIterationResult = {
  decision: AutonomousLoopDecision
  sessionID: string | null
  pendingRevisionID: string | null
  promotedRevisionID: string | null
  rejectionReason: string | null
}

type PersistedAutonomousLoopIteration = {
  startedAt: string
  completedAt: string
  sessionID: string | null
  decision: AutonomousLoopDecision
  pendingRevisionID: string | null
  promotedRevisionID: string | null
  rejectionReason: string | null
  prompt: string
}

type PersistedAutonomousLoopState = {
  lastSessionID: string | null
  latestLearning: string | null
  iterations: PersistedAutonomousLoopIteration[]
}

type EvaluationScenarioResult = {
  scenarioName: string
  resultDir: string
  workspaceRoot: string
  stdout: string
  stderr: string
  exitCode: number
  changedFiles: string[]
}

type RunEvaluationScenario = (input: {
  repoRoot: string
  scenarioName: string
}) => Promise<EvaluationScenarioResult>

export type RunAutonomousIterationInput = {
  repoRoot: string
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  prompt: string
  verificationCommands?: string[][]
  evaluationScenarios?: string[]
  executeCommand?: (input: {
    cwd: string
    command: string[]
  }) => Promise<AutonomousLoopCommandResult>
  runEvaluationScenario?: RunEvaluationScenario
}

export type AutonomousLoopWorkerConfig = {
  repoRoot: string
  pluginFilePath: string
  prompt: string
  intervalMs: number
  verificationCommands?: string[][]
  evaluationScenarios?: string[]
}

export type AutonomousLoopSchedulePolicy = {
  runInWorker: boolean
  intervalMs: number
}

type WorkerFactory = (filename: URL, options?: WorkerOptions) => Worker

const DEFAULT_VERIFICATION_COMMANDS = [
  ["bun", "run", "typecheck"],
  ["bun", "run", "test:unit"],
]

export const DEFAULT_AUTONOMOUS_LOOP_INTERVAL_MS = 15 * 60 * 1000

const MAX_ITERATION_HISTORY = 20

export async function runAutonomousIteration(
  input: RunAutonomousIterationInput,
): Promise<AutonomousLoopIterationResult> {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  const executeCommand = input.executeCommand ?? executeCommandInRepo
  const state = await loadAutonomousLoopState(input.pluginFilePath, input.runtimeContract)
  const startedAt = new Date().toISOString()
  const mutationPrompt = buildAutonomousPrompt(input.prompt, state.latestLearning)
  const mutationCommand = buildAutonomousRunCommand({
    repoRoot: input.repoRoot,
    prompt: mutationPrompt,
    sessionID: state.lastSessionID,
  })
  const mutationResult = await executeCommand({
    cwd: input.repoRoot,
    command: mutationCommand,
  })
  const sessionID = extractSessionID(mutationResult.stdout) ?? state.lastSessionID
  const registryAfterMutation = await loadRegistry(input.pluginFilePath, input.runtimeContract)
  const pendingRevisionID = registryAfterMutation.pendingRevision

  if (mutationResult.exitCode !== 0) {
    if (pendingRevisionID) {
      await rejectPendingRevision(input.pluginFilePath, input.runtimeContract)
    }

    return await finalizeAutonomousIteration({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      state,
      iteration: {
        startedAt,
        completedAt: new Date().toISOString(),
        sessionID,
        decision: "mutation_failed",
        pendingRevisionID,
        promotedRevisionID: null,
        rejectionReason: formatCommandFailure(mutationCommand, mutationResult),
        prompt: mutationPrompt,
      },
    })
  }

  if (!pendingRevisionID) {
    return await finalizeAutonomousIteration({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      state,
      iteration: {
        startedAt,
        completedAt: new Date().toISOString(),
        sessionID,
        decision: "no_pending_revision",
        pendingRevisionID: null,
        promotedRevisionID: null,
        rejectionReason: null,
        prompt: mutationPrompt,
      },
    })
  }

  const validation = await validateRegistryArtifacts(input.pluginFilePath, input.runtimeContract)

  if (validation.invalid.length > 0) {
    const rejectionReason = `registry validation failed: ${validation.invalid[0]?.reason ?? "unknown error"}`

    await rejectPendingRevision(input.pluginFilePath, input.runtimeContract)

    return await finalizeAutonomousIteration({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      state,
      iteration: {
        startedAt,
        completedAt: new Date().toISOString(),
        sessionID,
        decision: "rejected",
        pendingRevisionID,
        promotedRevisionID: null,
        rejectionReason,
        prompt: mutationPrompt,
      },
    })
  }

  for (const command of input.verificationCommands ?? DEFAULT_VERIFICATION_COMMANDS) {
    const verificationResult = await executeCommand({
      cwd: input.repoRoot,
      command,
    })

    if (verificationResult.exitCode !== 0) {
      await rejectPendingRevision(input.pluginFilePath, input.runtimeContract)

      return await finalizeAutonomousIteration({
        pluginFilePath: input.pluginFilePath,
        runtimeContract: input.runtimeContract,
        state,
        iteration: {
          startedAt,
          completedAt: new Date().toISOString(),
          sessionID,
          decision: "rejected",
          pendingRevisionID,
          promotedRevisionID: null,
          rejectionReason: formatCommandFailure(command, verificationResult),
          prompt: mutationPrompt,
        },
      })
    }
  }

  if ((input.evaluationScenarios?.length ?? 0) > 0) {
    if (!input.runEvaluationScenario) {
      throw new Error("evaluation scenarios require a runEvaluationScenario implementation")
    }

    for (const scenarioName of input.evaluationScenarios ?? []) {
      try {
        const evaluationResult = await input.runEvaluationScenario({
          repoRoot: input.repoRoot,
          scenarioName,
        })

        if (evaluationResult.exitCode !== 0) {
          await rejectPendingRevision(input.pluginFilePath, input.runtimeContract)

          return await finalizeAutonomousIteration({
            pluginFilePath: input.pluginFilePath,
            runtimeContract: input.runtimeContract,
            state,
            iteration: {
              startedAt,
              completedAt: new Date().toISOString(),
              sessionID,
              decision: "rejected",
              pendingRevisionID,
              promotedRevisionID: null,
              rejectionReason: `evaluation scenario failed: ${scenarioName}`,
              prompt: mutationPrompt,
            },
          })
        }
      } catch (error) {
        await rejectPendingRevision(input.pluginFilePath, input.runtimeContract)

        return await finalizeAutonomousIteration({
          pluginFilePath: input.pluginFilePath,
          runtimeContract: input.runtimeContract,
          state,
          iteration: {
            startedAt,
            completedAt: new Date().toISOString(),
            sessionID,
            decision: "rejected",
            pendingRevisionID,
            promotedRevisionID: null,
            rejectionReason: `evaluation scenario failed: ${scenarioName}: ${error instanceof Error ? error.message : String(error)}`,
            prompt: mutationPrompt,
          },
        })
      }
    }
  }

  await promotePendingRevision(input.pluginFilePath, input.runtimeContract)

  return await finalizeAutonomousIteration({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    state,
    iteration: {
      startedAt,
      completedAt: new Date().toISOString(),
      sessionID,
      decision: "promoted",
      pendingRevisionID,
      promotedRevisionID: pendingRevisionID,
      rejectionReason: null,
      prompt: mutationPrompt,
    },
  })
}

export function startAutonomousLoopWorker(
  config: AutonomousLoopWorkerConfig,
  createWorker: WorkerFactory = (filename, options) => new Worker(filename, options),
) {
  return createWorker(new URL("../../scripts/autonomous-loop-worker.ts", import.meta.url), {
    workerData: config,
  })
}

export function resolveAutonomousLoopStatePath(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  return join(kernelPaths.registryRoot, "autonomous-loop.json")
}

export function resolveAutonomousLoopSchedulePolicy(input: {
  workerRequested: boolean
  intervalMs: number
}): AutonomousLoopSchedulePolicy {
  if (input.intervalMs > 0) {
    return {
      runInWorker: true,
      intervalMs: input.intervalMs,
    }
  }

  if (input.workerRequested) {
    return {
      runInWorker: true,
      intervalMs: DEFAULT_AUTONOMOUS_LOOP_INTERVAL_MS,
    }
  }

  return {
    runInWorker: false,
    intervalMs: 0,
  }
}

function buildAutonomousRunCommand(input: {
  repoRoot: string
  prompt: string
  sessionID: string | null
}) {
  const command = [
    "opencode",
    "run",
    "--format",
    "json",
    "--dir",
    input.repoRoot,
    "--dangerously-skip-permissions",
  ]

  if (input.sessionID) {
    command.push("--session", input.sessionID)
  }

  command.push(input.prompt)

  return command
}

function buildAutonomousPrompt(prompt: string, latestLearning: string | null) {
  if (!latestLearning) {
    return prompt
  }

  return [
    "Previous autonomous-loop learning:",
    latestLearning,
    "",
    "New objective:",
    prompt,
  ].join("\n")
}

function extractSessionID(stdout: string) {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim()

    if (!trimmedLine) {
      continue
    }

    try {
      const parsed = JSON.parse(trimmedLine) as { sessionID?: unknown }

      if (typeof parsed.sessionID === "string") {
        return parsed.sessionID
      }
    } catch {
      continue
    }
  }

  return null
}

function formatCommandFailure(command: string[], result: AutonomousLoopCommandResult) {
  const stderr = result.stderr.trim()
  const stdout = result.stdout.trim()
  const detail = stderr || stdout || `exit code ${result.exitCode}`

  return `${command.join(" ")} failed: ${detail}`
}

async function loadAutonomousLoopState(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
): Promise<PersistedAutonomousLoopState> {
  try {
    return JSON.parse(
      await readFile(resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract), "utf8"),
    ) as PersistedAutonomousLoopState
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        lastSessionID: null,
        latestLearning: null,
        iterations: [],
      }
    }

    throw error
  }
}

async function persistAutonomousLoopState(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  state: PersistedAutonomousLoopState
}) {
  const statePath = resolveAutonomousLoopStatePath(input.pluginFilePath, input.runtimeContract)

  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(input.state, null, 2)}\n`)
}

async function finalizeAutonomousIteration(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  state: PersistedAutonomousLoopState
  iteration: PersistedAutonomousLoopIteration
}): Promise<AutonomousLoopIterationResult> {
  const latestLearning = buildIterationLearning(input.iteration)
  const nextState: PersistedAutonomousLoopState = {
    lastSessionID: input.iteration.sessionID,
    latestLearning,
    iterations: [...input.state.iterations, input.iteration].slice(-MAX_ITERATION_HISTORY),
  }

  await persistAutonomousLoopState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    state: nextState,
  })

  return {
    decision: input.iteration.decision,
    sessionID: input.iteration.sessionID,
    pendingRevisionID: input.iteration.pendingRevisionID,
    promotedRevisionID: input.iteration.promotedRevisionID,
    rejectionReason: input.iteration.rejectionReason,
  }
}

function buildIterationLearning(iteration: PersistedAutonomousLoopIteration) {
  if (iteration.decision === "promoted") {
    return `The last autonomous iteration was promoted at revision ${iteration.promotedRevisionID ?? "unknown"}.`
  }

  if (iteration.rejectionReason) {
    return `The last autonomous iteration was ${iteration.decision}: ${iteration.rejectionReason}`
  }

  return `The last autonomous iteration ended with decision ${iteration.decision}.`
}

async function executeCommandInRepo(input: {
  cwd: string
  command: string[]
}): Promise<AutonomousLoopCommandResult> {
  const [executable, ...args] = input.command

  if (!executable) {
    throw new Error("autonomous loop command is missing an executable")
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      })
    })
  })
}
