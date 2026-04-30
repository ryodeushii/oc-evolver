import { spawn } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Worker, type WorkerOptions } from "node:worker_threads"

import {
  ensureKernelRuntimePaths,
  loadRegistry,
  promotePendingRevision,
  rejectPendingRevision,
  rollbackLatestRevision,
  validateRegistryArtifacts,
} from "./registry.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"

export type AutonomousLoopCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type AutonomousLoopDecision =
  | "mutation_failed"
  | "no_pending_revision"
  | "promoted"
  | "rejected"
  | "rolled_back"
  | "skipped_locked"

export type AutonomousLoopIterationResult = {
  decision: AutonomousLoopDecision
  sessionID: string | null
  pendingRevisionID: string | null
  promotedRevisionID: string | null
  rejectionReason: string | null
}

type AutonomousLoopVerificationRecord = {
  command: string[]
  exitCode: number
}

type AutonomousLoopEvaluationRecord = {
  scenarioName: string
  exitCode: number
}

type AutonomousLoopObjective = {
  prompt: string
  status: "pending" | "completed"
  attempts: number
  updatedAt: string
  lastSessionID: string | null
  lastDecision: AutonomousLoopDecision | null
}

type PersistedAutonomousLoopLearning = {
  summary: string
  remainingObjectives: string[]
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
  objectivePrompt: string | null
  verification: AutonomousLoopVerificationRecord[]
  evaluations: AutonomousLoopEvaluationRecord[]
  changedArtifacts: string[]
}

type PersistedAutonomousLoopState = {
  config: {
    enabled: boolean
    paused: boolean
    intervalMs: number
    verificationCommands: string[][]
    evaluationScenarios: string[]
  }
  lastSessionID: string | null
  latestLearning: PersistedAutonomousLoopLearning | null
  objectives: AutonomousLoopObjective[]
  iterations: PersistedAutonomousLoopIteration[]
}

type LegacyPersistedAutonomousLoopState = {
  lastSessionID?: string | null
  latestLearning?: string | null
  iterations?: Array<Partial<PersistedAutonomousLoopIteration> & { prompt?: string }>
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
  prompt?: string
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
export const DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS = ["autonomous-run"]

const DEFAULT_AUTONOMOUS_LOOP_PROMPT =
  "Review the current project state, make one concrete improvement, and leave the workspace in a verified state."
const MAX_ITERATION_HISTORY = 20

export async function configureAutonomousLoop(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  repoRoot?: string
  intervalMs?: number
  verificationCommands?: string[][]
  evaluationScenarios?: string[]
  objectivePrompts?: string[]
  replaceObjectives?: boolean
  enabled?: boolean
  paused?: boolean
}) {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  const state = await loadAutonomousLoopState(input.pluginFilePath, input.runtimeContract)
  const now = new Date().toISOString()
  const nextObjectives = mergeObjectives({
    existing: state.objectives,
    prompts: input.objectivePrompts ?? [],
    replaceObjectives: input.replaceObjectives ?? false,
    now,
  })

  const nextState: PersistedAutonomousLoopState = {
    ...state,
    config: {
      enabled: input.enabled ?? state.config.enabled,
      paused: input.paused ?? state.config.paused,
      intervalMs: input.intervalMs ?? state.config.intervalMs,
      verificationCommands: normalizeCommandMatrix(
        input.verificationCommands ?? state.config.verificationCommands,
        DEFAULT_VERIFICATION_COMMANDS,
      ),
      evaluationScenarios:
        input.evaluationScenarios !== undefined
          ? dedupeStrings(input.evaluationScenarios)
          : normalizeScenarioList(state.config.evaluationScenarios),
    },
    objectives: nextObjectives,
  }

  nextState.latestLearning = buildLatestLearning(nextState.iterations.at(-1) ?? null, nextState.objectives)

  await persistAutonomousLoopState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    state: nextState,
  })

  return formatAutonomousLoopStatus(nextState)
}

export async function getAutonomousLoopStatus(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
}) {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  return formatAutonomousLoopStatus(
    await loadAutonomousLoopState(input.pluginFilePath, input.runtimeContract),
  )
}

export async function setAutonomousLoopPaused(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  paused: boolean
}) {
  return await configureAutonomousLoop({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    paused: input.paused,
  })
}

export async function setAutonomousLoopEnabled(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  enabled: boolean
  paused?: boolean
}) {
  return await configureAutonomousLoop({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    enabled: input.enabled,
    paused: input.paused,
  })
}

export async function runAutonomousIteration(
  input: RunAutonomousIterationInput,
): Promise<AutonomousLoopIterationResult> {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  const lockPath = resolveAutonomousLoopLockPath(input.pluginFilePath, input.runtimeContract)

  try {
    await mkdir(lockPath)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const state = await loadAutonomousLoopState(input.pluginFilePath, input.runtimeContract)

      return await finalizeAutonomousIteration({
        pluginFilePath: input.pluginFilePath,
        runtimeContract: input.runtimeContract,
        state,
        iteration: {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sessionID: null,
          decision: "skipped_locked",
          pendingRevisionID: null,
          promotedRevisionID: null,
          rejectionReason: `autonomous loop skipped: lock already held at ${lockPath}`,
          prompt: input.prompt ?? DEFAULT_AUTONOMOUS_LOOP_PROMPT,
          objectivePrompt: null,
          verification: [],
          evaluations: [],
          changedArtifacts: [],
        },
      })
    }

    throw error
  }

  try {
    const executeCommand = input.executeCommand ?? executeCommandInRepo
    const state = await loadAutonomousLoopState(input.pluginFilePath, input.runtimeContract)
    const startedAt = new Date().toISOString()
    const objectivePrompt = selectObjectivePrompt(state, input.prompt)
    const mutationPrompt = buildAutonomousPrompt(
      objectivePrompt ?? DEFAULT_AUTONOMOUS_LOOP_PROMPT,
      state.latestLearning,
    )
    const verificationCommands = normalizeCommandMatrix(
      input.verificationCommands ?? state.config.verificationCommands,
      DEFAULT_VERIFICATION_COMMANDS,
    )
    const evaluationScenarios =
      input.evaluationScenarios !== undefined
        ? dedupeStrings(input.evaluationScenarios)
        : normalizeScenarioList(state.config.evaluationScenarios)
    const mutationCommand = buildAutonomousRunCommand({
      repoRoot: input.repoRoot,
      prompt: mutationPrompt,
      sessionID: state.lastSessionID,
    })
    const registryBeforeMutation = await loadRegistry(input.pluginFilePath, input.runtimeContract)
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
          objectivePrompt,
          verification: [],
          evaluations: [],
          changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
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
          objectivePrompt,
          verification: [],
          evaluations: [],
          changedArtifacts: [],
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
          objectivePrompt,
          verification: [],
          evaluations: [],
          changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
        },
      })
    }

    const verification = await runVerificationCommands({
      cwd: input.repoRoot,
      commands: verificationCommands,
      executeCommand,
    })

    if (verification.failure) {
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
          rejectionReason: verification.failure,
          prompt: mutationPrompt,
          objectivePrompt,
          verification: verification.records,
          evaluations: [],
          changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
        },
      })
    }

    const evaluations = await runEvaluationScenarios({
      repoRoot: input.repoRoot,
      scenarios: evaluationScenarios,
      runEvaluationScenario: input.runEvaluationScenario,
    })

    if (evaluations.failure) {
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
          rejectionReason: evaluations.failure,
          prompt: mutationPrompt,
          objectivePrompt,
          verification: verification.records,
          evaluations: evaluations.records,
          changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
        },
      })
    }

    await promotePendingRevision(input.pluginFilePath, input.runtimeContract)

    if (registryBeforeMutation.currentRevision) {
      const healthVerification = await runVerificationCommands({
        cwd: input.repoRoot,
        commands: verificationCommands,
        executeCommand,
      })

      if (healthVerification.failure) {
        await rollbackLatestRevision(input.pluginFilePath, input.runtimeContract)

        return await finalizeAutonomousIteration({
          pluginFilePath: input.pluginFilePath,
          runtimeContract: input.runtimeContract,
          state,
          iteration: {
            startedAt,
            completedAt: new Date().toISOString(),
            sessionID,
            decision: "rolled_back",
            pendingRevisionID,
            promotedRevisionID: pendingRevisionID,
            rejectionReason: `post-promotion verification failed: ${healthVerification.failure}`,
            prompt: mutationPrompt,
            objectivePrompt,
            verification: [...verification.records, ...healthVerification.records],
            evaluations: evaluations.records,
            changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
          },
        })
      }

      const healthEvaluations = await runEvaluationScenarios({
        repoRoot: input.repoRoot,
        scenarios: evaluationScenarios,
        runEvaluationScenario: input.runEvaluationScenario,
      })

      if (healthEvaluations.failure) {
        await rollbackLatestRevision(input.pluginFilePath, input.runtimeContract)

        return await finalizeAutonomousIteration({
          pluginFilePath: input.pluginFilePath,
          runtimeContract: input.runtimeContract,
          state,
          iteration: {
            startedAt,
            completedAt: new Date().toISOString(),
            sessionID,
            decision: "rolled_back",
            pendingRevisionID,
            promotedRevisionID: pendingRevisionID,
            rejectionReason: `post-promotion evaluation failed: ${healthEvaluations.failure}`,
            prompt: mutationPrompt,
            objectivePrompt,
            verification: [...verification.records, ...healthVerification.records],
            evaluations: [...evaluations.records, ...healthEvaluations.records],
            changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
          },
        })
      }
    }

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
        objectivePrompt,
        verification: verification.records,
        evaluations: evaluations.records,
        changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
      },
    })
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
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

export function resolveAutonomousLoopLockPath(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  return join(kernelPaths.registryRoot, "autonomous-loop.lock")
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

function buildAutonomousPrompt(
  prompt: string,
  latestLearning: PersistedAutonomousLoopLearning | null,
) {
  if (!latestLearning) {
    return prompt
  }

  return [
    "Previous autonomous-loop learning:",
    latestLearning.summary,
    ...(latestLearning.remainingObjectives.length > 0
      ? ["", "Remaining queued objectives:", ...latestLearning.remainingObjectives.map((entry) => `- ${entry}`)]
      : []),
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
    return normalizeAutonomousLoopState(
      JSON.parse(
        await readFile(resolveAutonomousLoopStatePath(pluginFilePath, runtimeContract), "utf8"),
      ) as Partial<PersistedAutonomousLoopState> & LegacyPersistedAutonomousLoopState,
    )
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyAutonomousLoopState()
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
  const nextObjectives = updateObjectivesAfterIteration(input.state.objectives, input.iteration)
  const nextState: PersistedAutonomousLoopState = {
    ...input.state,
    lastSessionID: input.iteration.sessionID,
    latestLearning: buildLatestLearning(input.iteration, nextObjectives),
    objectives: nextObjectives,
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

async function runVerificationCommands(input: {
  cwd: string
  commands: string[][]
  executeCommand: (input: {
    cwd: string
    command: string[]
  }) => Promise<AutonomousLoopCommandResult>
}) {
  const records: AutonomousLoopVerificationRecord[] = []

  for (const command of input.commands) {
    const result = await input.executeCommand({
      cwd: input.cwd,
      command,
    })

    records.push({
      command,
      exitCode: result.exitCode,
    })

    if (result.exitCode !== 0) {
      return {
        records,
        failure: formatCommandFailure(command, result),
      }
    }
  }

  return {
    records,
    failure: null,
  }
}

async function runEvaluationScenarios(input: {
  repoRoot: string
  scenarios: string[]
  runEvaluationScenario?: RunEvaluationScenario
}) {
  const records: AutonomousLoopEvaluationRecord[] = []

  if (input.scenarios.length === 0) {
    return {
      records,
      failure: null,
    }
  }

  if (!input.runEvaluationScenario) {
    throw new Error("evaluation scenarios require a runEvaluationScenario implementation")
  }

  for (const scenarioName of input.scenarios) {
    try {
      const result = await input.runEvaluationScenario({
        repoRoot: input.repoRoot,
        scenarioName,
      })

      records.push({
        scenarioName,
        exitCode: result.exitCode,
      })

      if (result.exitCode !== 0) {
        return {
          records,
          failure: `evaluation scenario failed: ${scenarioName}`,
        }
      }
    } catch (error) {
      return {
        records,
        failure: `evaluation scenario failed: ${scenarioName}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  return {
    records,
    failure: null,
  }
}

function buildLatestLearning(
  iteration: PersistedAutonomousLoopIteration | null,
  objectives: AutonomousLoopObjective[],
): PersistedAutonomousLoopLearning | null {
  if (!iteration) {
    return objectives.length === 0
      ? null
      : {
          summary: "No autonomous iterations have completed yet.",
          remainingObjectives: objectives.filter((objective) => objective.status === "pending").map((objective) => objective.prompt),
        }
  }

  const remainingObjectives = objectives
    .filter((objective) => objective.status === "pending")
    .map((objective) => objective.prompt)

  if (iteration.decision === "promoted") {
    return {
      summary: `The last autonomous iteration was promoted at revision ${iteration.promotedRevisionID ?? "unknown"}.`,
      remainingObjectives,
    }
  }

  if (iteration.decision === "rolled_back") {
    return {
      summary: `The last autonomous iteration was promoted and then rolled back: ${iteration.rejectionReason ?? "post-promotion health checks failed"}`,
      remainingObjectives,
    }
  }

  if (iteration.rejectionReason) {
    return {
      summary: `The last autonomous iteration was ${iteration.decision}: ${iteration.rejectionReason}`,
      remainingObjectives,
    }
  }

  return {
    summary: `The last autonomous iteration ended with decision ${iteration.decision}.`,
    remainingObjectives,
  }
}

function collectChangedArtifacts(registry: Awaited<ReturnType<typeof loadRegistry>>, revisionID: string | null) {
  if (!revisionID) {
    return []
  }

  const changed = [
    ...Object.entries(registry.skills)
      .filter(([, entry]) => entry.revisionID === revisionID)
      .map(([name]) => `skill:${name}`),
    ...Object.entries(registry.agents)
      .filter(([, entry]) => entry.revisionID === revisionID)
      .map(([name]) => `agent:${name}`),
    ...Object.entries(registry.commands)
      .filter(([, entry]) => entry.revisionID === revisionID)
      .map(([name]) => `command:${name}`),
    ...Object.entries(registry.memories)
      .filter(([, entry]) => entry.revisionID === revisionID)
      .map(([name]) => `memory:${name}`),
  ]

  return changed.sort()
}

function emptyAutonomousLoopState(): PersistedAutonomousLoopState {
  return {
    config: {
      enabled: false,
      paused: false,
      intervalMs: DEFAULT_AUTONOMOUS_LOOP_INTERVAL_MS,
      verificationCommands: structuredClone(DEFAULT_VERIFICATION_COMMANDS),
      evaluationScenarios: [...DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS],
    },
    lastSessionID: null,
    latestLearning: null,
    objectives: [],
    iterations: [],
  }
}

function normalizeAutonomousLoopState(
  rawState: Partial<PersistedAutonomousLoopState> & LegacyPersistedAutonomousLoopState,
): PersistedAutonomousLoopState {
  const emptyState = emptyAutonomousLoopState()
  const legacyLatestLearning =
    typeof rawState.latestLearning === "string"
      ? {
          summary: rawState.latestLearning,
          remainingObjectives: [],
        }
      : rawState.latestLearning ?? null

  return {
    config: {
      enabled: rawState.config?.enabled ?? emptyState.config.enabled,
      paused: rawState.config?.paused ?? emptyState.config.paused,
      intervalMs: rawState.config?.intervalMs ?? emptyState.config.intervalMs,
      verificationCommands: normalizeCommandMatrix(
        rawState.config?.verificationCommands,
        emptyState.config.verificationCommands,
      ),
      evaluationScenarios: normalizeScenarioList(rawState.config?.evaluationScenarios),
    },
    lastSessionID: rawState.lastSessionID ?? null,
    latestLearning: legacyLatestLearning,
    objectives: Array.isArray(rawState.objectives)
      ? rawState.objectives.map((objective) => ({
          prompt: objective.prompt,
          status: objective.status === "completed" ? "completed" : "pending",
          attempts: typeof objective.attempts === "number" ? objective.attempts : 0,
          updatedAt: objective.updatedAt ?? new Date(0).toISOString(),
          lastSessionID: objective.lastSessionID ?? null,
          lastDecision: objective.lastDecision ?? null,
        }))
      : [],
    iterations: Array.isArray(rawState.iterations)
      ? rawState.iterations.map((iteration) => ({
          startedAt: iteration.startedAt ?? new Date(0).toISOString(),
          completedAt: iteration.completedAt ?? new Date(0).toISOString(),
          sessionID: iteration.sessionID ?? null,
          decision: normalizeDecision(iteration.decision),
          pendingRevisionID: iteration.pendingRevisionID ?? null,
          promotedRevisionID: iteration.promotedRevisionID ?? null,
          rejectionReason: iteration.rejectionReason ?? null,
          prompt: iteration.prompt ?? DEFAULT_AUTONOMOUS_LOOP_PROMPT,
          objectivePrompt: iteration.objectivePrompt ?? null,
          verification: Array.isArray(iteration.verification)
            ? iteration.verification.map((record) => ({
                command: Array.isArray(record.command) ? record.command.filter((entry) => typeof entry === "string") : [],
                exitCode: typeof record.exitCode === "number" ? record.exitCode : 1,
              }))
            : [],
          evaluations: Array.isArray(iteration.evaluations)
            ? iteration.evaluations.map((record) => ({
                scenarioName: record.scenarioName,
                exitCode: typeof record.exitCode === "number" ? record.exitCode : 1,
              }))
            : [],
          changedArtifacts: Array.isArray(iteration.changedArtifacts)
            ? iteration.changedArtifacts.filter((entry): entry is string => typeof entry === "string")
            : [],
        }))
      : [],
  }
}

function normalizeDecision(decision: unknown): AutonomousLoopDecision {
  if (
    decision === "mutation_failed" ||
    decision === "no_pending_revision" ||
    decision === "promoted" ||
    decision === "rejected" ||
    decision === "rolled_back" ||
    decision === "skipped_locked"
  ) {
    return decision
  }

  return "rejected"
}

function normalizeCommandMatrix(commands: string[][] | undefined, fallback: string[][]) {
  const normalized = (commands ?? fallback)
    .map((command) => command.filter(Boolean))
    .filter((command) => command.length > 0)

  return normalized.length > 0 ? normalized : structuredClone(fallback)
}

function normalizeScenarioList(scenarios: string[] | undefined) {
  const normalized = dedupeStrings(scenarios ?? DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS)

  return normalized.length > 0 ? normalized : [...DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS]
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const value of values) {
    const next = value.trim()

    if (!next || seen.has(next)) {
      continue
    }

    seen.add(next)
    normalized.push(next)
  }

  return normalized
}

function mergeObjectives(input: {
  existing: AutonomousLoopObjective[]
  prompts: string[]
  replaceObjectives: boolean
  now: string
}): AutonomousLoopObjective[] {
  const existingPrompts = input.replaceObjectives
    ? []
    : input.existing.map((objective) => objective.prompt)
  const nextPrompts = dedupeStrings([...existingPrompts, ...input.prompts])

  return nextPrompts.map((prompt) => {
    const existing = input.existing.find((objective) => objective.prompt === prompt)

    if (existing && !input.replaceObjectives) {
      return existing
    }

    return {
      prompt,
      status:
        existing?.status === "completed" && !input.replaceObjectives
          ? ("completed" as const)
          : ("pending" as const),
      attempts: existing?.attempts ?? 0,
      updatedAt: existing?.updatedAt ?? input.now,
      lastSessionID: existing?.lastSessionID ?? null,
      lastDecision: existing?.lastDecision ?? null,
    }
  })
}

function selectObjectivePrompt(state: PersistedAutonomousLoopState, overridePrompt?: string) {
  if (overridePrompt?.trim()) {
    return overridePrompt.trim()
  }

  return state.objectives.find((objective) => objective.status === "pending")?.prompt ?? null
}

function updateObjectivesAfterIteration(
  objectives: AutonomousLoopObjective[],
  iteration: PersistedAutonomousLoopIteration,
): AutonomousLoopObjective[] {
  if (!iteration.objectivePrompt) {
    return objectives
  }

  return objectives.map((objective) => {
    if (objective.prompt !== iteration.objectivePrompt) {
      return objective
    }

    if (iteration.decision === "skipped_locked") {
      return objective
    }

    return {
      ...objective,
      status: iteration.decision === "promoted" ? ("completed" as const) : ("pending" as const),
      attempts: objective.attempts + 1,
      updatedAt: iteration.completedAt,
      lastSessionID: iteration.sessionID,
      lastDecision: iteration.decision,
    }
  })
}

function formatAutonomousLoopStatus(state: PersistedAutonomousLoopState) {
  return {
    config: state.config,
    lastSessionID: state.lastSessionID,
    latestLearning: state.latestLearning,
    objectives: state.objectives,
    iterations: state.iterations,
  }
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
