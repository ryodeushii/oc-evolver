import { spawn } from "node:child_process"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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
  | "skipped_paused"
  | "skipped_unrunnable"

export type AutonomousLoopIterationResult = {
  decision: AutonomousLoopDecision
  sessionID: string | null
  pendingRevisionID: string | null
  promotedRevisionID: string | null
  rejectionReason: string | null
}

export type AutonomousLoopStatus = {
  config: PersistedAutonomousLoopState["config"]
  lastSessionID: string | null
  latestLearning: PersistedAutonomousLoopLearning | null
  objectives: AutonomousLoopObjective[]
  iterations: PersistedAutonomousLoopIteration[]
}

export type AutonomousLoopActivationResult = {
  config: PersistedAutonomousLoopState["config"]
  lastSessionID: string | null
  latestLearning: PersistedAutonomousLoopLearning | null
  objectives: AutonomousLoopObjective[]
  iterations: PersistedAutonomousLoopIteration[]
  activation: {
    mode: "inline" | "paused" | "worker" | "worker_already_running"
  }
  iteration: AutonomousLoopIterationResult | null
}

type AutonomousLoopVerificationRecord = {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
}

type AutonomousLoopObjectiveCompletionCriteria = {
  changedArtifacts?: string[]
  evaluationScenarios?: string[]
  verificationCommands?: string[][]
}

type AutonomousLoopObjectiveCompletionEvidence = {
  satisfied: boolean
  changedArtifacts: string[]
  passedEvaluationScenarios: string[]
  passedVerificationCommands: string[][]
  missingChangedArtifacts: string[]
  missingEvaluationScenarios: string[]
  missingVerificationCommands: string[][]
  checkedAt: string
}

type AutonomousLoopFailureEscalationAction = "pause_loop" | "quarantine_objective"

type AutonomousLoopFailurePolicy = {
  maxConsecutiveFailures: number
  escalationAction: AutonomousLoopFailureEscalationAction
  lastEscalationReason: string | null
}

type AutonomousLoopEvaluationRecord = {
  scenarioName: string
  exitCode: number
  stdout: string
  stderr: string
  changedFiles: string[]
}

type AutonomousLoopObjectiveSource = "manual" | "repair" | "invalid_artifact" | "learning"

type AutonomousLoopObjective = {
  prompt: string
  priority: number
  status: "pending" | "completed" | "quarantined"
  source: AutonomousLoopObjectiveSource
  rationale: string | null
  completionCriteria: AutonomousLoopObjectiveCompletionCriteria | null
  lastCompletionEvidence: AutonomousLoopObjectiveCompletionEvidence | null
  attempts: number
  consecutiveFailures: number
  updatedAt: string
  lastSessionID: string | null
  lastDecision: AutonomousLoopDecision | null
  lastEscalationReason: string | null
}

type PersistedAutonomousLoopLearning = {
  summary: string
  remainingObjectives: string[]
  lastDecision: AutonomousLoopDecision | null
  rejectionReason: string | null
  failedVerificationCommands: string[][]
  failedEvaluationScenarios: string[]
  changedArtifacts: string[]
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
    failurePolicy: AutonomousLoopFailurePolicy
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

type AutonomousLoopLockMetadata = {
  acquiredAt: string
}

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

type RuntimeContractFlags = {
  runFlags: string[]
}

export type AutonomousLoopSchedulePolicy = {
  runInWorker: boolean
  intervalMs: number
}

type WorkerFactory = (filename: URL, options?: WorkerOptions) => Worker

type ActivateAutonomousLoopDependencies = {
  runIteration?: (input: RunAutonomousIterationInput) => Promise<AutonomousLoopIterationResult>
  startWorker?: (config: AutonomousLoopWorkerConfig) => Worker
  runEvaluationScenario?: RunEvaluationScenario
}

type ActiveAutonomousLoopWorker = {
  worker: Worker
  configSignature: string
}

type AutonomousLoopObjectiveInput = {
  prompt: string
  priority?: number
  completionCriteria?: AutonomousLoopObjectiveCompletionCriteria | null
}

const DEFAULT_VERIFICATION_COMMANDS = [
  ["bun", "run", "typecheck"],
  ["bun", "run", "test:unit"],
]

export const DEFAULT_AUTONOMOUS_LOOP_INTERVAL_MS = 15 * 60 * 1000
export const DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS = ["autonomous-run"]
const DEFAULT_AUTONOMOUS_LOOP_FAILURE_POLICY: AutonomousLoopFailurePolicy = {
  maxConsecutiveFailures: 3,
  escalationAction: "pause_loop",
  lastEscalationReason: null,
}

const DEFAULT_AUTONOMOUS_LOOP_PROMPT =
  "Review the current project state, consult autonomous-loop status and prior learning, make one concrete improvement, and leave the workspace in a verified state."
const MAX_AUTONOMOUS_LOOP_REPAIR_ATTEMPTS = 1
const MAX_AUTONOMOUS_LOOP_LOCK_AGE_MS = 60 * 60 * 1000
const AUTONOMOUS_LOOP_LOCK_METADATA_FILE = "metadata.json"
const MAX_ITERATION_HISTORY = 20
const activeAutonomousLoopWorkers = new Map<string, ActiveAutonomousLoopWorker>()

export async function configureAutonomousLoop(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  intervalMs?: number
  verificationCommands?: string[][]
  evaluationScenarios?: string[]
  failurePolicy?: Partial<AutonomousLoopFailurePolicy>
  objectives?: AutonomousLoopObjectiveInput[]
  replaceObjectives?: boolean
  enabled?: boolean
  paused?: boolean
}) {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)
  assertValidFailurePolicyOverride(input.failurePolicy)

  const state = await loadAutonomousLoopState(input.pluginFilePath, input.runtimeContract)
  const now = new Date().toISOString()
  const nextObjectives = mergeObjectives({
    existing: state.objectives,
    inputs: normalizeObjectiveInputs(input.objectives),
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
          : dedupeStrings(state.config.evaluationScenarios),
      failurePolicy: normalizeFailurePolicy(input.failurePolicy, state.config.failurePolicy),
    },
    objectives: nextObjectives,
  }

  nextState.latestLearning = buildLatestLearning(nextState.iterations.at(-1) ?? null, nextState.objectives)

  await persistAutonomousLoopState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    state: nextState,
  })

  return formatAutonomousLoopStatus(
    await refreshDerivedObjectives({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      state: nextState,
    }),
  )
}

export async function getAutonomousLoopStatus(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
}): Promise<AutonomousLoopStatus> {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  return formatAutonomousLoopStatus(
    await loadAutonomousLoopStateWithDerivedObjectives(input.pluginFilePath, input.runtimeContract),
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

export async function stopAutonomousLoop(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
}) {
  const result = await configureAutonomousLoop({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    enabled: false,
    paused: true,
  })

  const worker = activeAutonomousLoopWorkers.get(input.pluginFilePath)

  if (worker) {
    activeAutonomousLoopWorkers.delete(input.pluginFilePath)
    await worker.worker.terminate()
  }

  return {
    ...result,
    activation: {
      mode: "stopped",
    },
  }
}

export type AutonomousLoopMetrics = {
  totalIterations: number
  promotedCount: number
  rejectedCount: number
  rolledBackCount: number
  skippedCount: number
  mutationFailedCount: number
  noPendingRevisionCount: number
  promotionRate: number
  avgIterationDurationMs: number
  lastIterationDurationMs: number | null
  objectivesCompleted: number
  objectivesPending: number
  objectivesQuarantined: number
  latestIteration: {
    startedAt: string
    completedAt: string
    decision: string
  } | null
  since: string
}

export async function getAutonomousLoopMetrics(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
}): Promise<AutonomousLoopMetrics> {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  const state = await loadAutonomousLoopStateWithDerivedObjectives(
    input.pluginFilePath,
    input.runtimeContract,
  )

  return computeAutonomousLoopMetrics(state)
}

function computeAutonomousLoopMetrics(state: PersistedAutonomousLoopState): AutonomousLoopMetrics {
  const iterations = state.iterations
  const total = iterations.length

  const promoted = iterations.filter((it) => it.decision === "promoted").length
  const rejected = iterations.filter((it) => it.decision === "rejected").length
  const rolledBack = iterations.filter((it) => it.decision === "rolled_back").length
  const skipped = iterations.filter((it) =>
    it.decision === "skipped_locked" ||
    it.decision === "skipped_paused" ||
    it.decision === "skipped_unrunnable",
  ).length
  const mutationFailed = iterations.filter((it) => it.decision === "mutation_failed").length
  const noPendingRevision = iterations.filter((it) => it.decision === "no_pending_revision").length

  let avgDurationMs = 0
  let lastDurationMs: number | null = null

  for (const it of iterations) {
    const duration = Date.parse(it.completedAt) - Date.parse(it.startedAt)

    if (!Number.isNaN(duration)) {
      avgDurationMs += duration

      if (it === iterations[iterations.length - 1]) {
        lastDurationMs = duration
      }
    }
  }

  if (total > 0) {
    avgDurationMs = Math.round(avgDurationMs / total)
  }

  const latest = iterations.at(-1) ?? null
  const latestIteration = latest
    ? {
        startedAt: latest.startedAt,
        completedAt: latest.completedAt,
        decision: latest.decision,
      }
    : null

  const objectives = state.objectives

  return {
    totalIterations: total,
    promotedCount: promoted,
    rejectedCount: rejected,
    rolledBackCount: rolledBack,
    skippedCount: skipped,
    mutationFailedCount: mutationFailed,
    noPendingRevisionCount: noPendingRevision,
    promotionRate: total > 0 ? Math.round((promoted / total) * 100) / 100 : 0,
    avgIterationDurationMs: avgDurationMs,
    lastIterationDurationMs: lastDurationMs,
    objectivesCompleted: objectives.filter((o) => o.status === "completed").length,
    objectivesPending: objectives.filter((o) => o.status === "pending").length,
    objectivesQuarantined: objectives.filter((o) => o.status === "quarantined").length,
    latestIteration,
    since: iterations[0]?.startedAt ?? new Date().toISOString(),
  }
}

export type AutonomousLoopPreview = {
  wouldRun: boolean
  wouldSkipReason: string | null
  selectedObjective: string | null
  selectedObjectiveSource: AutonomousLoopObjectiveSource | null
  selectedObjectiveRationale: string | null
  mutationPrompt: string | null
  verificationCommands: string[][]
  evaluationScenarios: string[]
  config: {
    enabled: boolean
    paused: boolean
    intervalMs: number
  }
  lockHeld: boolean
  runtimeContractCompatible: boolean
  runtimeContractDetail: string | null
  pendingObjectives: string[]
}

type ResolvedAutonomousObjective = {
  objectivePrompt: string | null
  mutationPrompt: string
}

export async function previewAutonomousIteration(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  prompt?: string
}): Promise<AutonomousLoopPreview> {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  const state = await loadAutonomousLoopStateWithDerivedObjectives(
    input.pluginFilePath,
    input.runtimeContract,
  )
  const lockPath = resolveAutonomousLoopLockPath(input.pluginFilePath, input.runtimeContract)
  let lockHeld = false

  try {
    const lockStat = await stat(lockPath)
    lockHeld = lockStat.isDirectory()
  } catch {
    lockHeld = false
  }

  const resolvedObjective = resolveAutonomousObjective(state, input.prompt)
  const objectivePrompt = resolvedObjective.objectivePrompt
  const selectedObjective = objectivePrompt
    ? state.objectives.find((objective) => objective.prompt === objectivePrompt) ?? null
    : null
  const pendingObjectives = state.objectives
    .filter((o) => o.status === "pending")
    .map((o) => o.prompt)

  const configuredVerificationCommands = normalizeCommandMatrix(
    state.config.verificationCommands,
    DEFAULT_VERIFICATION_COMMANDS,
  )
  const verificationCommands = dedupeCommandMatrix([
    ...configuredVerificationCommands,
    ...collectObjectiveVerificationCommands(state.objectives, objectivePrompt),
  ])
  const configuredEvaluationScenarios = dedupeStrings(state.config.evaluationScenarios)
  const evaluationScenarios = dedupeStrings([
    ...configuredEvaluationScenarios,
    ...collectObjectiveEvaluationScenarios(state.objectives, objectivePrompt),
  ])

  let wouldRun = true
  let wouldSkipReason: string | null = null

  if (!state.config.enabled) {
    wouldRun = false
    wouldSkipReason = "autonomous loop is disabled"
  } else if (state.config.paused) {
    wouldRun = false
    wouldSkipReason = "autonomous loop is paused"
  } else if (lockHeld) {
    wouldRun = false
    wouldSkipReason = "autonomous loop lock is already held (another iteration may be running)"
  }

  const runtimeContractCompatible = input.runtimeContract.runFlags.includes("--dangerously-skip-permissions") &&
    input.runtimeContract.runFlags.includes("--format") &&
    input.runtimeContract.runFlags.includes("--dir")

  const runtimeContractDetail = runtimeContractCompatible
    ? null
    : "runtime contract is missing required autonomous run flags"

  return {
    wouldRun,
    wouldSkipReason,
    selectedObjective: objectivePrompt,
    selectedObjectiveSource: selectedObjective?.source ?? (objectivePrompt ? "manual" : null),
    selectedObjectiveRationale: selectedObjective?.rationale ?? null,
    mutationPrompt: resolvedObjective.mutationPrompt,
    verificationCommands,
    evaluationScenarios,
    config: {
      enabled: state.config.enabled,
      paused: state.config.paused,
      intervalMs: state.config.intervalMs,
    },
    lockHeld,
    runtimeContractCompatible,
    runtimeContractDetail,
    pendingObjectives,
  }
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

export async function activateAutonomousLoop(
  input: {
    repoRoot: string
    pluginFilePath: string
    runtimeContract: OCEvolverRuntimeContract
  },
  dependencies: ActivateAutonomousLoopDependencies = {},
  options: {
    resumePaused?: boolean
  } = {},
): Promise<AutonomousLoopActivationResult> {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  const status = await setAutonomousLoopEnabled({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    enabled: true,
    paused: options.resumePaused ? false : (await getAutonomousLoopStatus({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
    })).config.paused,
  })

  if (status.config.paused) {
    return {
      ...status,
      activation: {
        mode: "paused",
      },
      iteration: null,
    }
  }
  const policy = resolveAutonomousLoopSchedulePolicy({
    workerRequested: false,
    intervalMs: status.config.intervalMs,
  })
  const workerKey = input.pluginFilePath
  const existingWorker = activeAutonomousLoopWorkers.get(workerKey)

  if (policy.runInWorker) {
    const workerConfig: AutonomousLoopWorkerConfig = {
      repoRoot: input.repoRoot,
      pluginFilePath: input.pluginFilePath,
      intervalMs: policy.intervalMs,
      verificationCommands: status.config.verificationCommands,
      evaluationScenarios: status.config.evaluationScenarios,
    }
    const nextConfigSignature = JSON.stringify(workerConfig)

    if (existingWorker) {
      if (existingWorker.configSignature === nextConfigSignature) {
        return {
          ...status,
          activation: {
            mode: "worker_already_running",
          },
          iteration: null,
        }
      }

      activeAutonomousLoopWorkers.delete(workerKey)
      await existingWorker.worker.terminate()
    }

    const startWorker =
      dependencies.startWorker ??
      ((config: AutonomousLoopWorkerConfig) => startAutonomousLoopWorker(config))
    const worker = startWorker(workerConfig)

    activeAutonomousLoopWorkers.set(workerKey, {
      worker,
      configSignature: nextConfigSignature,
    })

    worker.once("exit", () => {
      const activeWorker = activeAutonomousLoopWorkers.get(workerKey)

      if (activeWorker?.worker === worker) {
        activeAutonomousLoopWorkers.delete(workerKey)
      }
    })
    worker.once("error", () => {
      const activeWorker = activeAutonomousLoopWorkers.get(workerKey)

      if (activeWorker?.worker === worker) {
        activeAutonomousLoopWorkers.delete(workerKey)
      }
    })

    return {
      ...status,
      activation: {
        mode: "worker",
      },
      iteration: null,
    }
  }

  if (existingWorker) {
    activeAutonomousLoopWorkers.delete(workerKey)
    await existingWorker.worker.terminate()
  }

  const runIteration = dependencies.runIteration ?? runAutonomousIteration
  const iteration = await runIteration({
    repoRoot: input.repoRoot,
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    verificationCommands: status.config.verificationCommands,
    evaluationScenarios: status.config.evaluationScenarios,
    runEvaluationScenario: dependencies.runEvaluationScenario,
  })

  return {
    ...(await getAutonomousLoopStatus({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
    })),
    activation: {
      mode: "inline",
    },
    iteration,
  }
}

export async function runAutonomousIteration(
  input: RunAutonomousIterationInput,
): Promise<AutonomousLoopIterationResult> {
  await ensureKernelRuntimePaths(input.pluginFilePath, input.runtimeContract)

  const lockPath = resolveAutonomousLoopLockPath(input.pluginFilePath, input.runtimeContract)

  const lockAcquisition = await acquireAutonomousLoopLock(lockPath)

  if (!lockAcquisition.acquired) {
    const state = await loadAutonomousLoopStateWithDerivedObjectives(
      input.pluginFilePath,
      input.runtimeContract,
    )
    const resolvedObjective = resolveAutonomousObjective(state, input.prompt)

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
        rejectionReason: lockAcquisition.reason,
        prompt: resolvedObjective.mutationPrompt,
        objectivePrompt: resolvedObjective.objectivePrompt,
        verification: [],
        evaluations: [],
        changedArtifacts: [],
      },
    })
  }

  try {
    const executeCommand = input.executeCommand ?? executeCommandInRepo
    const state = await loadAutonomousLoopStateWithDerivedObjectives(
      input.pluginFilePath,
      input.runtimeContract,
    )
    const startedAt = new Date().toISOString()
    const resolvedObjective = resolveAutonomousObjective(state, input.prompt)
    const objectivePrompt = resolvedObjective.objectivePrompt

    if (state.config.paused) {
      return await finalizeAutonomousIteration({
        pluginFilePath: input.pluginFilePath,
        runtimeContract: input.runtimeContract,
        state,
        iteration: {
          startedAt,
          completedAt: new Date().toISOString(),
          sessionID: null,
          decision: "skipped_paused",
          pendingRevisionID: null,
          promotedRevisionID: null,
          rejectionReason: "autonomous loop skipped: loop is paused",
          prompt: resolvedObjective.mutationPrompt,
          objectivePrompt,
          verification: [],
          evaluations: [],
          changedArtifacts: [],
        },
      })
    }

    const mutationPrompt = resolvedObjective.mutationPrompt
    const configuredVerificationCommands = normalizeCommandMatrix(
      input.verificationCommands ?? state.config.verificationCommands,
      DEFAULT_VERIFICATION_COMMANDS,
    )
    const verificationCommands = dedupeCommandMatrix([
      ...configuredVerificationCommands,
      ...collectObjectiveVerificationCommands(state.objectives, objectivePrompt),
    ])
    const configuredEvaluationScenarios =
      input.evaluationScenarios !== undefined
        ? dedupeStrings(input.evaluationScenarios)
        : dedupeStrings(state.config.evaluationScenarios)
    const evaluationScenarios = dedupeStrings([
      ...configuredEvaluationScenarios,
      ...collectObjectiveEvaluationScenarios(state.objectives, objectivePrompt),
    ])
    const runtimeContractMismatch = await validateAutonomousRuntimeContractCompatibility({
      repoRoot: input.repoRoot,
      runtimeContract: input.runtimeContract,
      sessionID: state.lastSessionID,
      executeCommand,
    })

    if (runtimeContractMismatch) {
      return await finalizeAutonomousIteration({
        pluginFilePath: input.pluginFilePath,
        runtimeContract: input.runtimeContract,
        state,
        iteration: {
          startedAt,
          completedAt: new Date().toISOString(),
          sessionID: null,
          decision: "skipped_unrunnable",
          pendingRevisionID: null,
          promotedRevisionID: null,
          rejectionReason: runtimeContractMismatch,
          prompt: mutationPrompt,
          objectivePrompt,
          verification: [],
          evaluations: [],
          changedArtifacts: [],
        },
      })
    }

    if (evaluationScenarios.length > 0 && !input.runEvaluationScenario) {
      return await finalizeAutonomousIteration({
        pluginFilePath: input.pluginFilePath,
        runtimeContract: input.runtimeContract,
        state,
        iteration: {
          startedAt,
          completedAt: new Date().toISOString(),
          sessionID: null,
          decision: "skipped_unrunnable",
          pendingRevisionID: null,
          promotedRevisionID: null,
          rejectionReason:
            "autonomous loop rejected: evaluation scenarios require a runEvaluationScenario implementation",
          prompt: mutationPrompt,
          objectivePrompt,
          verification: [],
          evaluations: [],
          changedArtifacts: [],
        },
      })
    }

    const registryBeforeMutation = await loadRegistry(input.pluginFilePath, input.runtimeContract)
    const aggregatedVerificationRecords: AutonomousLoopVerificationRecord[] = []
    const aggregatedEvaluationRecords: AutonomousLoopEvaluationRecord[] = []
    const basePrompt = objectivePrompt ?? DEFAULT_AUTONOMOUS_LOOP_PROMPT
    let currentPrompt = mutationPrompt
    let currentSessionID = state.lastSessionID
    let sessionID = state.lastSessionID
    let pendingRevisionID: string | null = null
    let registryAfterMutation = registryBeforeMutation
    let verification = {
      records: [] as AutonomousLoopVerificationRecord[],
      failure: null as string | null,
    }
    let evaluations = {
      records: [] as AutonomousLoopEvaluationRecord[],
      failure: null as string | null,
    }

    for (let repairAttempt = 0; repairAttempt <= MAX_AUTONOMOUS_LOOP_REPAIR_ATTEMPTS; repairAttempt += 1) {
      const mutationCommand = buildAutonomousRunCommand({
        repoRoot: input.repoRoot,
        prompt: currentPrompt,
        sessionID: currentSessionID,
        runtimeContract: input.runtimeContract,
      })
      const mutationResult = await executeCommand({
        cwd: input.repoRoot,
        command: mutationCommand,
      })

      sessionID = extractSessionID(mutationResult.stdout) ?? currentSessionID
      registryAfterMutation = await loadRegistry(input.pluginFilePath, input.runtimeContract)
      pendingRevisionID = registryAfterMutation.pendingRevision

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
            prompt: currentPrompt,
            objectivePrompt,
            verification: aggregatedVerificationRecords,
            evaluations: aggregatedEvaluationRecords,
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
            prompt: currentPrompt,
            objectivePrompt,
            verification: aggregatedVerificationRecords,
            evaluations: aggregatedEvaluationRecords,
            changedArtifacts: [],
          },
        })
      }

      const changedArtifacts = collectChangedArtifacts(registryAfterMutation, pendingRevisionID)
      const validation = await validateRegistryArtifacts(input.pluginFilePath, input.runtimeContract, {
        recordAudit: false,
      })

      if (validation.invalid.length > 0) {
        const rejectionReason = `registry validation failed: ${validation.invalid[0]?.reason ?? "unknown error"}`

        await rejectPendingRevision(input.pluginFilePath, input.runtimeContract)

        if (repairAttempt < MAX_AUTONOMOUS_LOOP_REPAIR_ATTEMPTS) {
          currentPrompt = buildAutonomousRepairPrompt({
            prompt: basePrompt,
            latestLearning: state.latestLearning,
            rejectionReason,
            changedArtifacts,
          })
          currentSessionID = sessionID
          continue
        }

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
            prompt: currentPrompt,
            objectivePrompt,
            verification: aggregatedVerificationRecords,
            evaluations: aggregatedEvaluationRecords,
            changedArtifacts,
          },
        })
      }

      verification = await runVerificationCommands({
        cwd: input.repoRoot,
        commands: verificationCommands,
        executeCommand,
      })
      aggregatedVerificationRecords.push(...verification.records)

      if (verification.failure) {
        await rejectPendingRevision(input.pluginFilePath, input.runtimeContract)

        if (repairAttempt < MAX_AUTONOMOUS_LOOP_REPAIR_ATTEMPTS) {
          currentPrompt = buildAutonomousRepairPrompt({
            prompt: basePrompt,
            latestLearning: state.latestLearning,
            rejectionReason: verification.failure,
            changedArtifacts,
          })
          currentSessionID = sessionID
          continue
        }

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
            prompt: currentPrompt,
            objectivePrompt,
            verification: aggregatedVerificationRecords,
            evaluations: aggregatedEvaluationRecords,
            changedArtifacts,
          },
        })
      }

      evaluations = await runEvaluationScenarios({
        repoRoot: input.repoRoot,
        scenarios: evaluationScenarios,
        runEvaluationScenario: input.runEvaluationScenario,
      })
      aggregatedEvaluationRecords.push(...evaluations.records)

      if (evaluations.failure) {
        await rejectPendingRevision(input.pluginFilePath, input.runtimeContract)

        if (repairAttempt < MAX_AUTONOMOUS_LOOP_REPAIR_ATTEMPTS) {
          currentPrompt = buildAutonomousRepairPrompt({
            prompt: basePrompt,
            latestLearning: state.latestLearning,
            rejectionReason: evaluations.failure,
            changedArtifacts,
          })
          currentSessionID = sessionID
          continue
        }

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
            prompt: currentPrompt,
            objectivePrompt,
            verification: aggregatedVerificationRecords,
            evaluations: aggregatedEvaluationRecords,
            changedArtifacts,
          },
        })
      }

      break
    }

    await promotePendingRevision(input.pluginFilePath, input.runtimeContract)

    let finalVerificationRecords = aggregatedVerificationRecords
    let finalEvaluationRecords = aggregatedEvaluationRecords

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
            prompt: currentPrompt,
            objectivePrompt,
            verification: [...aggregatedVerificationRecords, ...healthVerification.records],
            evaluations: aggregatedEvaluationRecords,
            changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
          },
        })
      }

      finalVerificationRecords = [...aggregatedVerificationRecords, ...healthVerification.records]

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
            prompt: currentPrompt,
            objectivePrompt,
            verification: [...aggregatedVerificationRecords, ...healthVerification.records],
            evaluations: [...aggregatedEvaluationRecords, ...healthEvaluations.records],
            changedArtifacts: collectChangedArtifacts(registryAfterMutation, pendingRevisionID),
          },
        })
      }

      finalEvaluationRecords = [...aggregatedEvaluationRecords, ...healthEvaluations.records]
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
        prompt: currentPrompt,
        objectivePrompt,
        verification: finalVerificationRecords,
        evaluations: finalEvaluationRecords,
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

function resolveAutonomousLoopLockMetadataPath(lockPath: string) {
  return join(lockPath, AUTONOMOUS_LOOP_LOCK_METADATA_FILE)
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
  runtimeContract: OCEvolverRuntimeContract
}) {
  assertRuntimeContractSupportsAutonomousRun(input.runtimeContract, input.sessionID)

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

function assertRuntimeContractSupportsAutonomousRun(
  runtimeContract: OCEvolverRuntimeContract,
  sessionID: string | null,
) {
  const requiredFlags = resolveAutonomousRunRequiredFlags(sessionID)
  const missingFlags = requiredFlags.filter((flag) => !runtimeContract.runFlags.includes(flag))

  if (missingFlags.length > 0) {
    throw new Error(
      `runtime contract is missing required autonomous run flags: ${missingFlags.join(", ")}`,
    )
  }
}

function resolveAutonomousRunRequiredFlags(sessionID: string | null) {
  return [
    "--format",
    "--dir",
    "--dangerously-skip-permissions",
    ...(sessionID ? ["--session"] : []),
  ]
}

function buildAutonomousPrompt(
  prompt: string,
  latestLearning: PersistedAutonomousLoopLearning | null,
) {
  if (!latestLearning) {
    return prompt
  }

  const structured: string[] = []

  if (latestLearning.lastDecision) {
    structured.push(`Last decision: ${latestLearning.lastDecision}`)
  }

  if (latestLearning.rejectionReason) {
    structured.push(`Rejection reason: ${latestLearning.rejectionReason}`)
  }

  if (latestLearning.failedVerificationCommands.length > 0) {
    structured.push(
      `Failed verification commands: ${latestLearning.failedVerificationCommands
        .map((command) => formatCommandLabel(command))
        .join(", ")}`,
    )
  }

  if (latestLearning.failedEvaluationScenarios.length > 0) {
    structured.push(
      `Failed evaluation scenarios: ${latestLearning.failedEvaluationScenarios.join(", ")}`,
    )
  }

  if (latestLearning.changedArtifacts.length > 0) {
    structured.push(
      `Artifacts changed in the failed attempt: ${latestLearning.changedArtifacts.join(", ")}`,
    )
  }

  return [
    "Previous autonomous-loop learning:",
    latestLearning.summary,
    ...(structured.length > 0 ? ["", ...structured] : []),
    ...(latestLearning.remainingObjectives.length > 0
      ? ["", "Remaining queued objectives:", ...latestLearning.remainingObjectives.map((entry) => `- ${entry}`)]
      : []),
    "",
    "New objective:",
    prompt,
  ].join("\n")
}

function buildAutonomousRepairPrompt(input: {
  prompt: string
  latestLearning: PersistedAutonomousLoopLearning | null
  rejectionReason: string
  changedArtifacts: string[]
}) {
  const repairPrompt = [
    input.prompt,
    "",
    "Repair the last autonomous attempt.",
    `Failure: ${input.rejectionReason}`,
    ...(input.changedArtifacts.length > 0
      ? ["", "Artifacts changed in the rejected attempt:", ...input.changedArtifacts.map((entry) => `- ${entry}`)]
      : []),
    "",
    "Keep the useful changes, fix the failure, and leave the workspace in a verified state.",
  ].join("\n")

  return buildAutonomousPrompt(repairPrompt, input.latestLearning)
}

async function validateAutonomousRuntimeContractCompatibility(input: {
  repoRoot: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string | null
  executeCommand: (input: { cwd: string; command: string[] }) => Promise<AutonomousLoopCommandResult>
}) {
  const versionResult = await input.executeCommand({
    cwd: input.repoRoot,
    command: ["opencode", "--version"],
  })

  if (versionResult.exitCode !== 0) {
    return formatRuntimeContractFailure({
      command: ["opencode", "--version"],
      result: versionResult,
    })
  }

  const liveVersion = extractOpencodeVersion(versionResult.stdout, versionResult.stderr)

  if (liveVersion !== input.runtimeContract.opencodeVersion) {
    return `runtime contract mismatch: expected opencode ${input.runtimeContract.opencodeVersion} but found ${liveVersion ?? "unknown"}`
  }

  const runtimeFlags = await loadRuntimeContractFlags({
    repoRoot: input.repoRoot,
    executeCommand: input.executeCommand,
  })

  if ("reason" in runtimeFlags) {
    return runtimeFlags.reason
  }

  const missingRunFlags = resolveAutonomousRunRequiredFlags(input.sessionID).filter(
    (flag) => !runtimeFlags.runFlags.includes(flag),
  )

  if (missingRunFlags.length > 0) {
    return `runtime contract mismatch: opencode run is missing required flags: ${missingRunFlags.join(", ")}`
  }

  return null
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

function formatRuntimeContractFailure(input: {
  command: string[]
  result: AutonomousLoopCommandResult
}) {
  return `runtime contract check failed: ${formatCommandFailure(input.command, input.result)}`
}

async function loadRuntimeContractFlags(input: {
  repoRoot: string
  executeCommand: (input: { cwd: string; command: string[] }) => Promise<AutonomousLoopCommandResult>
}): Promise<RuntimeContractFlags | { reason: string }> {
  const runHelp = await input.executeCommand({
    cwd: input.repoRoot,
    command: ["opencode", "run", "--help"],
  })

  if (runHelp.exitCode !== 0) {
    return {
      reason: formatRuntimeContractFailure({
        command: ["opencode", "run", "--help"],
        result: runHelp,
      }),
    }
  }

  return {
    runFlags: extractFlagsFromHelp(runHelp.stdout, runHelp.stderr),
  }
}

function extractOpencodeVersion(stdout: string, stderr: string) {
  const output = `${stdout}\n${stderr}`
  const match = output.match(/\b\d+\.\d+\.\d+\b/)

  return match?.[0] ?? null
}

function extractFlagsFromHelp(stdout: string, stderr: string) {
  return dedupeStrings(`${stdout}\n${stderr}`.match(/--[a-z0-9-]+/gi) ?? [])
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

async function loadAutonomousLoopStateWithDerivedObjectives(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
): Promise<PersistedAutonomousLoopState> {
  return await refreshDerivedObjectives({
    pluginFilePath,
    runtimeContract,
    state: await loadAutonomousLoopState(pluginFilePath, runtimeContract),
  })
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

async function acquireAutonomousLoopLock(lockPath: string) {
  const now = new Date().toISOString()

  try {
    await createAutonomousLoopLock(lockPath, now)

    return {
      acquired: true as const,
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error
    }
  }

  if (!(await isAutonomousLoopLockStale(lockPath, now))) {
    return {
      acquired: false as const,
      reason: `autonomous loop skipped: lock already held at ${lockPath}`,
    }
  }

  await rm(lockPath, { recursive: true, force: true })

  try {
    await createAutonomousLoopLock(lockPath, now)

    return {
      acquired: true as const,
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return {
        acquired: false as const,
        reason: `autonomous loop skipped: lock already held at ${lockPath}`,
      }
    }

    throw error
  }
}

async function createAutonomousLoopLock(lockPath: string, acquiredAt: string) {
  await mkdir(lockPath)

  try {
    await writeAutonomousLoopLockMetadata(lockPath, { acquiredAt })
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true })
    throw error
  }
}

async function writeAutonomousLoopLockMetadata(
  lockPath: string,
  metadata: AutonomousLoopLockMetadata,
) {
  await writeFile(
    resolveAutonomousLoopLockMetadataPath(lockPath),
    `${JSON.stringify(metadata, null, 2)}\n`,
  )
}

async function isAutonomousLoopLockStale(lockPath: string, now: string) {
  const metadata = await readAutonomousLoopLockMetadata(lockPath)

  if (!metadata) {
    return false
  }

  const acquiredAt = Date.parse(metadata.acquiredAt)
  const nowMs = Date.parse(now)

  if (Number.isNaN(acquiredAt) || Number.isNaN(nowMs)) {
    return false
  }

  return nowMs - acquiredAt > MAX_AUTONOMOUS_LOOP_LOCK_AGE_MS
}

async function readAutonomousLoopLockMetadata(
  lockPath: string,
): Promise<AutonomousLoopLockMetadata | null> {
  try {
    const rawMetadata = JSON.parse(
      await readFile(resolveAutonomousLoopLockMetadataPath(lockPath), "utf8"),
    ) as Partial<AutonomousLoopLockMetadata>

    if (typeof rawMetadata.acquiredAt !== "string") {
      return null
    }

    return {
      acquiredAt: rawMetadata.acquiredAt,
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }

    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

async function finalizeAutonomousIteration(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  state: PersistedAutonomousLoopState
  iteration: PersistedAutonomousLoopIteration
}): Promise<AutonomousLoopIterationResult> {
  const nextObjectives = enqueueDerivedObjective(
    updateObjectivesAfterIteration(input.state.objectives, input.iteration),
    deriveFollowUpObjectiveFromIteration({
      existingObjectives: input.state.objectives,
      iteration: input.iteration,
    }),
  )
  const escalation = applyFailureEscalation({
    config: input.state.config,
    objectives: nextObjectives,
    iteration: input.iteration,
  })
  const nextState: PersistedAutonomousLoopState = {
    ...input.state,
    config: escalation.config,
    lastSessionID: input.iteration.sessionID ?? input.state.lastSessionID,
    latestLearning: buildLatestLearning(
      input.iteration,
      escalation.objectives,
      escalation.config.failurePolicy.lastEscalationReason,
    ),
    objectives: escalation.objectives,
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

async function refreshDerivedObjectives(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  state: PersistedAutonomousLoopState
}) {
  const nextObjectives = await reconcileDerivedObjectives(input)

  if (areObjectivesEquivalent(nextObjectives, input.state.objectives)) {
    return input.state
  }

  const nextState: PersistedAutonomousLoopState = {
    ...input.state,
    latestLearning: buildLatestLearning(
      input.state.iterations.at(-1) ?? null,
      nextObjectives,
      input.state.config.failurePolicy.lastEscalationReason,
    ),
    objectives: nextObjectives,
  }

  await persistAutonomousLoopState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    state: nextState,
  })

  return nextState
}

async function reconcileDerivedObjectives(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  state: PersistedAutonomousLoopState
}) {
  const preservedObjectives = input.state.objectives.filter(
    (objective) => !isDerivedObjectiveSource(objective.source),
  )

  if (preservedObjectives.some((objective) => objective.status === "pending")) {
    return preservedObjectives
  }

  const proposals = await collectDerivedObjectiveProposals({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    state: input.state,
  })

  return proposals.reduce(
    (objectives, proposal) =>
      enqueueDerivedObjective(objectives, createDerivedObjectiveFromProposal(proposal)),
    preservedObjectives,
  )
}

async function collectDerivedObjectiveProposals(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  state: PersistedAutonomousLoopState
}) {
  const validation = await validateRegistryArtifacts(input.pluginFilePath, input.runtimeContract, {
    recordAudit: false,
  })
  const sortedInvalidArtifacts = [...validation.invalid].sort((left, right) => {
    const leftTarget = normalizeInvalidArtifactTarget(left)
    const rightTarget = normalizeInvalidArtifactTarget(right)

    if (leftTarget === rightTarget) {
      return left.reason.localeCompare(right.reason)
    }

    return leftTarget.localeCompare(rightTarget)
  })
  const invalidTargets = dedupeStrings(
    sortedInvalidArtifacts.map((artifact) => normalizeInvalidArtifactTarget(artifact)),
  )
  const proposals: Array<{
    prompt: string
    priority: number
    source: "invalid_artifact" | "learning"
    rationale: string
    completionCriteria: AutonomousLoopObjectiveCompletionCriteria | null
  }> = []

  if (invalidTargets.length > 0) {
    proposals.push({
      prompt: buildInvalidArtifactObjectivePrompt(sortedInvalidArtifacts),
      priority: -100,
      source: "invalid_artifact",
      rationale: `Detected ${invalidTargets.length} invalid mutable artifact${invalidTargets.length === 1 ? "" : "s"} during registry validation.`,
      completionCriteria: normalizeObjectiveCompletionCriteria({
        changedArtifacts: invalidTargets,
      }),
    })
  }

  const learningProposal = buildLatestLearningObjectiveProposal(input.state)

  if (learningProposal) {
    proposals.push(learningProposal)
  }

  return proposals
}

function createDerivedObjectiveFromProposal(proposal: {
  prompt: string
  priority: number
  source: "invalid_artifact" | "learning"
  rationale: string
  completionCriteria: AutonomousLoopObjectiveCompletionCriteria | null
}): AutonomousLoopObjective | null {
  if (!proposal.completionCriteria) {
    return null
  }

  return {
    prompt: proposal.prompt,
    priority: proposal.priority,
    status: "pending",
    source: proposal.source,
    rationale: proposal.rationale,
    completionCriteria: proposal.completionCriteria,
    lastCompletionEvidence: null,
    attempts: 0,
    consecutiveFailures: 0,
    updatedAt: new Date(0).toISOString(),
    lastSessionID: null,
    lastDecision: null,
    lastEscalationReason: null,
  }
}

function buildInvalidArtifactObjectivePrompt(invalidArtifacts: Awaited<
  ReturnType<typeof validateRegistryArtifacts>
>["invalid"]) {
  return [
    "Repair invalid mutable artifacts detected in the evolution roots.",
    ...invalidArtifacts.map(
      (artifact) => `- ${normalizeInvalidArtifactTarget(artifact)}: ${artifact.reason}`,
    ),
    "Create a revision that restores valid mutable artifacts and leaves the loop in a verified state.",
  ].join("\n")
}

function normalizeInvalidArtifactTarget(artifact: Awaited<
  ReturnType<typeof validateRegistryArtifacts>
>["invalid"][number]) {
  const skillMatch = artifact.target.match(/\.opencode\/skills\/([^/]+)\/SKILL\.md$/)

  if (skillMatch) {
    return `skill:${skillMatch[1]}`
  }

  const agentMatch = artifact.target.match(/\.opencode\/agent\/([^/]+)\.md$/)

  if (agentMatch) {
    return `agent:${agentMatch[1]}`
  }

  const commandMatch = artifact.target.match(/\.opencode\/commands\/([^/]+)\.md$/)

  if (commandMatch) {
    return `command:${commandMatch[1]}`
  }

  const memoryMatch = artifact.target.match(/\.opencode\/memory\/([^/]+)\.md$/)

  if (memoryMatch) {
    return `memory:${memoryMatch[1]}`
  }

  return artifact.target
}

function buildLatestLearningObjectiveProposal(
  state: PersistedAutonomousLoopState,
): {
  prompt: string
  priority: number
  source: "learning"
  rationale: string
  completionCriteria: AutonomousLoopObjectiveCompletionCriteria | null
} | null {
  const latestIteration = state.iterations.at(-1) ?? null
  const latestLearning = state.latestLearning

  if (!latestIteration || !latestLearning || latestIteration.objectivePrompt) {
    return null
  }

  if (latestIteration.decision !== "rejected" && latestIteration.decision !== "rolled_back") {
    return null
  }

  const completionCriteria = normalizeObjectiveCompletionCriteria({
    changedArtifacts: latestLearning.changedArtifacts,
    verificationCommands: latestLearning.failedVerificationCommands,
    evaluationScenarios: latestLearning.failedEvaluationScenarios,
  })

  if (!completionCriteria) {
    return null
  }

  return {
    prompt: buildAutonomousFailureObjectivePrompt({
      objectivePrompt: DEFAULT_AUTONOMOUS_LOOP_PROMPT,
      rejectionReason: latestLearning.rejectionReason,
      completionCriteria,
    }),
    priority: -50,
    source: "learning",
    rationale:
      "Synthesized from the latest autonomous-loop learning after a failed default-prompt iteration.",
    completionCriteria,
  }
}

function isDerivedObjectiveSource(source: AutonomousLoopObjectiveSource) {
  return source === "invalid_artifact" || source === "learning"
}

function areObjectivesEquivalent(left: AutonomousLoopObjective[], right: AutonomousLoopObjective[]) {
  return JSON.stringify(left) === JSON.stringify(right)
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
      stdout: result.stdout,
      stderr: result.stderr,
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
        stdout: result.stdout,
        stderr: result.stderr,
        changedFiles: [...result.changedFiles],
      })

      if (result.exitCode !== 0) {
        return {
          records,
          failure: `evaluation scenario failed: ${scenarioName}`,
        }
      }
    } catch (error) {
      records.push({
        scenarioName,
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        changedFiles: [],
      })

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
  lastEscalationReason: string | null = null,
): PersistedAutonomousLoopLearning | null {
  const remainingObjectives = objectives
    .filter((objective) => objective.status === "pending")
    .map((objective) => objective.prompt)

  if (!iteration) {
    return objectives.length === 0
      ? null
      : {
          summary:
            lastEscalationReason
              ? `No autonomous iterations have completed yet. ${lastEscalationReason}`
              : "No autonomous iterations have completed yet.",
          remainingObjectives,
          lastDecision: null,
          rejectionReason: null,
          failedVerificationCommands: [],
          failedEvaluationScenarios: [],
          changedArtifacts: [],
        }
  }

  const latestObjective = iteration.objectivePrompt
    ? objectives.find((objective) => objective.prompt === iteration.objectivePrompt) ?? null
    : null
  const failedVerificationCommands = dedupeCommandMatrix(
    iteration.verification
      .filter((record) => record.exitCode !== 0)
      .map((record) => record.command),
  )
  const failedEvaluationScenarios = iteration.evaluations
    .filter((record) => record.exitCode !== 0)
    .map((record) => record.scenarioName)

  if (iteration.decision === "promoted") {
    return {
      summary:
        `${latestObjective?.status === "pending"
          ? `The last autonomous iteration was promoted at revision ${iteration.promotedRevisionID ?? "unknown"}, but objective "${latestObjective.prompt}" remains pending because ${describePendingObjectiveReason(latestObjective)}.`
          : `The last autonomous iteration was promoted at revision ${iteration.promotedRevisionID ?? "unknown"}.`}${lastEscalationReason ? ` ${lastEscalationReason}` : ""}`,
      remainingObjectives,
      lastDecision: iteration.decision,
      rejectionReason: iteration.rejectionReason,
      failedVerificationCommands,
      failedEvaluationScenarios,
      changedArtifacts: iteration.changedArtifacts,
    }
  }

  if (iteration.decision === "rolled_back") {
    return {
      summary: `The last autonomous iteration was promoted and then rolled back: ${iteration.rejectionReason ?? "post-promotion health checks failed"}${lastEscalationReason ? ` ${lastEscalationReason}` : ""}`,
      remainingObjectives,
      lastDecision: iteration.decision,
      rejectionReason: iteration.rejectionReason,
      failedVerificationCommands,
      failedEvaluationScenarios,
      changedArtifacts: iteration.changedArtifacts,
    }
  }

  if (iteration.rejectionReason) {
    return {
      summary: `The last autonomous iteration was ${iteration.decision}: ${iteration.rejectionReason}${lastEscalationReason ? ` ${lastEscalationReason}` : ""}`,
      remainingObjectives,
      lastDecision: iteration.decision,
      rejectionReason: iteration.rejectionReason,
      failedVerificationCommands,
      failedEvaluationScenarios,
      changedArtifacts: iteration.changedArtifacts,
    }
  }

  return {
    summary: `The last autonomous iteration ended with decision ${iteration.decision}.${lastEscalationReason ? ` ${lastEscalationReason}` : ""}`,
    remainingObjectives,
    lastDecision: iteration.decision,
    rejectionReason: null,
    failedVerificationCommands,
    failedEvaluationScenarios,
    changedArtifacts: iteration.changedArtifacts,
  }
}

function describePendingObjectiveReason(objective: AutonomousLoopObjective) {
  if (!objective.completionCriteria) {
    return "no explicit completion criteria are configured"
  }

  const missingRequirements = [
    ...(objective.lastCompletionEvidence?.missingChangedArtifacts ?? []).map(
      (artifact) => `changed artifact ${artifact}`,
    ),
    ...(objective.lastCompletionEvidence?.missingEvaluationScenarios ?? []).map(
      (scenarioName) => `evaluation scenario ${scenarioName}`,
    ),
    ...(objective.lastCompletionEvidence?.missingVerificationCommands ?? []).map(
      (command) => `verification command ${formatCommandLabel(command)}`,
    ),
  ]

  if (missingRequirements.length === 0) {
    return "its completion criteria were not satisfied"
  }

  return `it still needs ${missingRequirements.join(" and ")}`
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
      failurePolicy: structuredClone(DEFAULT_AUTONOMOUS_LOOP_FAILURE_POLICY),
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
  const objectives = Array.isArray(rawState.objectives)
    ? rawState.objectives.flatMap((objective) => {
        const completionCriteria = normalizeObjectiveCompletionCriteria(objective.completionCriteria)

        if (!completionCriteria) {
          return []
        }

        const lastCompletionEvidence = normalizeObjectiveCompletionEvidence(
          objective.lastCompletionEvidence,
        )
        const status: AutonomousLoopObjective["status"] =
          objective.status === "quarantined"
            ? "quarantined"
            : objective.status === "completed" &&
                doesObjectiveCompletionEvidenceSatisfyCriteria(
                  completionCriteria,
                  lastCompletionEvidence,
                )
              ? "completed"
              : "pending"

        return {
          prompt: objective.prompt,
          priority: typeof objective.priority === "number" ? objective.priority : 0,
          status,
          source:
            objective.source === "repair" ||
            objective.source === "invalid_artifact" ||
            objective.source === "learning"
              ? objective.source
              : "manual",
          rationale: typeof objective.rationale === "string" ? objective.rationale : null,
          completionCriteria,
          lastCompletionEvidence,
          attempts: typeof objective.attempts === "number" ? objective.attempts : 0,
          consecutiveFailures:
            typeof objective.consecutiveFailures === "number" ? objective.consecutiveFailures : 0,
          updatedAt: objective.updatedAt ?? new Date(0).toISOString(),
          lastSessionID: objective.lastSessionID ?? null,
          lastDecision: objective.lastDecision ?? null,
          lastEscalationReason: objective.lastEscalationReason ?? null,
        }
      })
    : []
  const iterations = Array.isArray(rawState.iterations)
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
              stdout: typeof record.stdout === "string" ? record.stdout : "",
              stderr: typeof record.stderr === "string" ? record.stderr : "",
            }))
          : [],
        evaluations: Array.isArray(iteration.evaluations)
          ? iteration.evaluations.map((record) => ({
              scenarioName: record.scenarioName,
              exitCode: typeof record.exitCode === "number" ? record.exitCode : 1,
              stdout: typeof record.stdout === "string" ? record.stdout : "",
              stderr: typeof record.stderr === "string" ? record.stderr : "",
              changedFiles: Array.isArray(record.changedFiles)
                ? record.changedFiles.filter((entry): entry is string => typeof entry === "string")
                : [],
            }))
          : [],
        changedArtifacts: Array.isArray(iteration.changedArtifacts)
          ? iteration.changedArtifacts.filter((entry): entry is string => typeof entry === "string")
          : [],
      }))
    : []

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
      failurePolicy: normalizeFailurePolicy(rawState.config?.failurePolicy, emptyState.config.failurePolicy),
    },
    lastSessionID: rawState.lastSessionID ?? null,
    latestLearning: buildLatestLearning(
      iterations.at(-1) ?? null,
      objectives,
      normalizeFailurePolicy(rawState.config?.failurePolicy, emptyState.config.failurePolicy)
        .lastEscalationReason,
    ),
    objectives,
    iterations,
  }
}

function normalizeFailurePolicy(
  input: Partial<AutonomousLoopFailurePolicy> | undefined,
  fallback: AutonomousLoopFailurePolicy,
): AutonomousLoopFailurePolicy {
  return {
    maxConsecutiveFailures:
      typeof input?.maxConsecutiveFailures === "number" && input.maxConsecutiveFailures > 0
        ? Math.floor(input.maxConsecutiveFailures)
        : fallback.maxConsecutiveFailures,
    escalationAction:
      input?.escalationAction === "quarantine_objective" || input?.escalationAction === "pause_loop"
        ? input.escalationAction
        : fallback.escalationAction,
    lastEscalationReason:
      typeof input?.lastEscalationReason === "string"
        ? input.lastEscalationReason
        : fallback.lastEscalationReason,
  }
}

function assertValidFailurePolicyOverride(input: Partial<AutonomousLoopFailurePolicy> | undefined) {
  if (input?.maxConsecutiveFailures === undefined) {
    return
  }

  if (
    !Number.isInteger(input.maxConsecutiveFailures) ||
    input.maxConsecutiveFailures <= 0
  ) {
    throw new Error("failurePolicy.maxConsecutiveFailures must be a positive integer")
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
    || decision === "skipped_paused"
    || decision === "skipped_unrunnable"
  ) {
    return decision
  }

  return "rejected"
}

function normalizeCommandMatrix(commands: string[][] | undefined, fallback: string[][]) {
  if (commands === undefined) {
    return normalizeCommandMatrix(fallback, [])
  }

  const normalized = (commands ?? fallback)
    .map((command) => command.filter(Boolean))
    .filter((command) => command.length > 0)

  return normalized.length > 0 ? normalized : []
}

function normalizeScenarioList(scenarios: string[] | undefined) {
  return scenarios === undefined
    ? [...DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS]
    : dedupeStrings(scenarios)
}

function normalizeVerificationCommandCriteria(commands: string[][] | undefined) {
  return dedupeCommandMatrix(normalizeCommandMatrix(commands, []))
}

function dedupeCommandMatrix(commands: string[][]) {
  const seen = new Set<string>()
  const deduped: string[][] = []

  for (const command of commands) {
    const key = command.join("\u0000")

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(command)
  }

  return deduped
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
  inputs: AutonomousLoopObjectiveInput[]
  replaceObjectives: boolean
  now: string
}): AutonomousLoopObjective[] {
  const nextInputs = new Map<string, AutonomousLoopObjectiveInput>()

    if (!input.replaceObjectives) {
      for (const objective of input.existing) {
        nextInputs.set(objective.prompt, {
          prompt: objective.prompt,
          priority: objective.priority,
          completionCriteria: objective.completionCriteria,
        })
      }
  }

  for (const objectiveInput of input.inputs) {
    nextInputs.set(objectiveInput.prompt, objectiveInput)
  }

  return Array.from(nextInputs.values()).map((objectiveInput) => {
    const existing = input.existing.find((objective) => objective.prompt === objectiveInput.prompt)
    const nextCriteria = normalizeObjectiveCompletionCriteria(objectiveInput.completionCriteria)
    const criteriaChanged = !areObjectiveCompletionCriteriaEqual(
      existing?.completionCriteria ?? null,
      nextCriteria,
    )

    if (existing && !input.replaceObjectives && !criteriaChanged) {
      return existing
    }

    return {
      prompt: objectiveInput.prompt,
      priority: objectiveInput.priority ?? existing?.priority ?? 0,
      status:
        existing?.status === "completed" && !input.replaceObjectives && !criteriaChanged
          ? ("completed" as const)
          : ("pending" as const),
      source:
        existing && !input.replaceObjectives && !criteriaChanged ? existing.source : "manual",
      rationale:
        existing && !input.replaceObjectives && !criteriaChanged ? existing.rationale : null,
      completionCriteria: nextCriteria,
      lastCompletionEvidence:
        existing && !criteriaChanged && !input.replaceObjectives
          ? existing.lastCompletionEvidence
          : null,
      attempts: existing?.attempts ?? 0,
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      updatedAt: input.now,
      lastSessionID: existing?.lastSessionID ?? null,
      lastDecision: existing?.lastDecision ?? null,
      lastEscalationReason:
        existing && !criteriaChanged && !input.replaceObjectives ? existing.lastEscalationReason : null,
    }
  })
}

function normalizeObjectiveInputs(objectives: AutonomousLoopObjectiveInput[] | undefined): AutonomousLoopObjectiveInput[] {
  const nextInputs = new Map<string, AutonomousLoopObjectiveInput>()

  for (const objective of objectives ?? []) {
    const nextPrompt = objective.prompt.trim()

    if (!nextPrompt) {
      continue
    }

    const completionCriteria = normalizeObjectiveCompletionCriteria(objective.completionCriteria)

    if (!completionCriteria) {
      throw new Error(`objective "${nextPrompt}" requires explicit completion criteria`)
    }

    nextInputs.set(nextPrompt, {
      prompt: nextPrompt,
      completionCriteria,
    })
  }

  return Array.from(nextInputs.values())
}

function selectObjectivePrompt(state: PersistedAutonomousLoopState, overridePrompt?: string) {
  if (overridePrompt?.trim()) {
    return overridePrompt.trim()
  }

  const pending = state.objectives.filter((objective) => objective.status === "pending")
  pending.sort((a, b) => b.priority - a.priority)

  return pending[0]?.prompt ?? null
}

function resolveAutonomousObjective(
  state: PersistedAutonomousLoopState,
  overridePrompt?: string,
): ResolvedAutonomousObjective {
  const objectivePrompt = selectObjectivePrompt(state, overridePrompt)

  return {
    objectivePrompt,
    mutationPrompt: buildAutonomousPrompt(
      objectivePrompt ?? DEFAULT_AUTONOMOUS_LOOP_PROMPT,
      state.latestLearning,
    ),
  }
}

function collectObjectiveEvaluationScenarios(
  objectives: AutonomousLoopObjective[],
  objectivePrompt: string | null,
) {
  if (!objectivePrompt) {
    return []
  }

  return objectives.find((objective) => objective.prompt === objectivePrompt)?.completionCriteria
    ?.evaluationScenarios ?? []
}

function collectObjectiveVerificationCommands(
  objectives: AutonomousLoopObjective[],
  objectivePrompt: string | null,
) {
  if (!objectivePrompt) {
    return []
  }

  return normalizeVerificationCommandCriteria(
    objectives.find((objective) => objective.prompt === objectivePrompt)?.completionCriteria
      ?.verificationCommands,
  )
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

    if (
      iteration.decision === "skipped_locked" ||
      iteration.decision === "skipped_paused" ||
      iteration.decision === "skipped_unrunnable"
    ) {
      return objective
    }

    const completionEvidence = evaluateObjectiveCompletion(iteration, objective.completionCriteria)

    return {
      ...objective,
      status:
        iteration.decision === "promoted" && completionEvidence.satisfied
          ? ("completed" as const)
          : ("pending" as const),
      lastCompletionEvidence: completionEvidence,
      attempts: objective.attempts + 1,
      consecutiveFailures:
        iteration.decision === "promoted" && completionEvidence.satisfied
          ? 0
          : objective.consecutiveFailures + 1,
      updatedAt: iteration.completedAt,
      lastSessionID: iteration.sessionID,
      lastDecision: iteration.decision,
      lastEscalationReason:
        iteration.decision === "promoted" && completionEvidence.satisfied
          ? null
          : objective.lastEscalationReason,
    }
  })
}

function deriveFollowUpObjectiveFromIteration(input: {
  existingObjectives: AutonomousLoopObjective[]
  iteration: PersistedAutonomousLoopIteration
}): AutonomousLoopObjective | null {
  if (
    !input.iteration.objectivePrompt ||
    (input.iteration.decision !== "rejected" && input.iteration.decision !== "rolled_back")
  ) {
    return null
  }

  const completionCriteria = normalizeObjectiveCompletionCriteria({
    changedArtifacts: input.iteration.changedArtifacts,
    evaluationScenarios: input.iteration.evaluations
      .filter((record) => record.exitCode !== 0)
      .map((record) => record.scenarioName),
    verificationCommands: input.iteration.verification
      .filter((record) => record.exitCode !== 0)
      .map((record) => record.command),
  })

  if (!completionCriteria) {
    return null
  }

  return {
    prompt: buildAutonomousFailureObjectivePrompt({
      objectivePrompt: input.iteration.objectivePrompt,
      rejectionReason: input.iteration.rejectionReason,
      completionCriteria,
    }),
    priority: 0,
    status: "pending",
    source: "repair",
    rationale: input.iteration.rejectionReason,
    completionCriteria,
    lastCompletionEvidence: null,
    attempts: 0,
    consecutiveFailures: 0,
    updatedAt: input.iteration.completedAt,
    lastSessionID: null,
    lastDecision: null,
    lastEscalationReason: null,
  }
}

function enqueueDerivedObjective(
  objectives: AutonomousLoopObjective[],
  derivedObjective: AutonomousLoopObjective | null,
) {
  if (!derivedObjective || objectives.some((objective) => objective.prompt === derivedObjective.prompt)) {
    return objectives
  }

  return [...objectives, derivedObjective]
}

function buildAutonomousFailureObjectivePrompt(input: {
  objectivePrompt: string
  rejectionReason: string | null
  completionCriteria: AutonomousLoopObjectiveCompletionCriteria
}) {
  const lines = [
    `Repair the failed autonomous attempt for objective: ${input.objectivePrompt}`,
    `Failure: ${input.rejectionReason ?? "autonomous loop failure"}`,
  ]

  if ((input.completionCriteria.changedArtifacts ?? []).length > 0) {
    lines.push(
      `Changed artifacts to preserve and repair: ${(input.completionCriteria.changedArtifacts ?? []).join(", ")}`,
    )
  }

  if ((input.completionCriteria.verificationCommands ?? []).length > 0) {
    lines.push(
      `Verification commands that must pass: ${(input.completionCriteria.verificationCommands ?? [])
        .map((command) => formatCommandLabel(command))
        .join(", ")}`,
    )
  }

  if ((input.completionCriteria.evaluationScenarios ?? []).length > 0) {
    lines.push(
      `Evaluation scenarios that must pass: ${(input.completionCriteria.evaluationScenarios ?? []).join(", ")}`,
    )
  }

  lines.push("Keep the useful mutable changes and bring the loop back to a verified state.")

  return lines.join("\n")
}

function applyFailureEscalation(input: {
  config: PersistedAutonomousLoopState["config"]
  objectives: AutonomousLoopObjective[]
  iteration: PersistedAutonomousLoopIteration
}) {
  if (!input.iteration.objectivePrompt) {
    return {
      config: input.config,
      objectives: input.objectives,
    }
  }

  const objective = input.objectives.find((entry) => entry.prompt === input.iteration.objectivePrompt)

  if (
    !objective ||
    objective.status === "completed" ||
    objective.consecutiveFailures < input.config.failurePolicy.maxConsecutiveFailures
  ) {
    return {
      config: {
        ...input.config,
        failurePolicy: {
          ...input.config.failurePolicy,
          lastEscalationReason:
            objective?.status === "completed" ? null : input.config.failurePolicy.lastEscalationReason,
        },
      },
      objectives: input.objectives,
    }
  }

  const reason = `Objective "${objective.prompt}" exceeded ${input.config.failurePolicy.maxConsecutiveFailures} consecutive failures with decision ${input.iteration.decision}.`
  const objectives = input.objectives.map((entry) => {
    if (entry.prompt !== objective.prompt) {
      return entry
    }

    return {
      ...entry,
      status:
        input.config.failurePolicy.escalationAction === "quarantine_objective"
          ? ("quarantined" as const)
          : entry.status,
      lastEscalationReason: reason,
    }
  })

  return {
    config:
      {
        ...input.config,
        ...(input.config.failurePolicy.escalationAction === "pause_loop" ? { paused: true } : {}),
        failurePolicy: {
          ...input.config.failurePolicy,
          lastEscalationReason: reason,
        },
      },
    objectives,
  }
}

function normalizeObjectiveCompletionCriteria(
  criteria: AutonomousLoopObjectiveCompletionCriteria | null | undefined,
): AutonomousLoopObjectiveCompletionCriteria | null {
  if (!criteria) {
    return null
  }

  const changedArtifacts = dedupeStrings(criteria.changedArtifacts ?? [])
  const evaluationScenarios = dedupeStrings(criteria.evaluationScenarios ?? [])
  const verificationCommands = normalizeVerificationCommandCriteria(criteria.verificationCommands)

  if (
    changedArtifacts.length === 0 &&
    evaluationScenarios.length === 0 &&
    verificationCommands.length === 0
  ) {
    return null
  }

  return {
    ...(changedArtifacts.length > 0 ? { changedArtifacts } : {}),
    ...(evaluationScenarios.length > 0 ? { evaluationScenarios } : {}),
    ...(verificationCommands.length > 0 ? { verificationCommands } : {}),
  }
}

function normalizeObjectiveCompletionEvidence(
  evidence: AutonomousLoopObjectiveCompletionEvidence | null | undefined,
): AutonomousLoopObjectiveCompletionEvidence | null {
  if (!evidence) {
    return null
  }

  return {
    satisfied: evidence.satisfied === true,
    changedArtifacts: dedupeStrings(evidence.changedArtifacts ?? []),
    passedEvaluationScenarios: dedupeStrings(evidence.passedEvaluationScenarios ?? []),
    passedVerificationCommands: normalizeVerificationCommandCriteria(evidence.passedVerificationCommands),
    missingChangedArtifacts: dedupeStrings(evidence.missingChangedArtifacts ?? []),
    missingEvaluationScenarios: dedupeStrings(evidence.missingEvaluationScenarios ?? []),
    missingVerificationCommands: normalizeVerificationCommandCriteria(evidence.missingVerificationCommands),
    checkedAt: evidence.checkedAt ?? new Date(0).toISOString(),
  }
}

function areObjectiveCompletionCriteriaEqual(
  left: AutonomousLoopObjectiveCompletionCriteria | null,
  right: AutonomousLoopObjectiveCompletionCriteria | null,
) {
  const normalizeForComparison = (criteria: AutonomousLoopObjectiveCompletionCriteria | null) => {
    if (!criteria) {
      return null
    }

    return {
      changedArtifacts: [...(criteria.changedArtifacts ?? [])].sort(),
      evaluationScenarios: [...(criteria.evaluationScenarios ?? [])].sort(),
      verificationCommands: normalizeVerificationCommandCriteria(criteria.verificationCommands)
        .map((command) => command.join("\u0000"))
        .sort(),
    }
  }

  return JSON.stringify(normalizeForComparison(left)) === JSON.stringify(normalizeForComparison(right))
}

function evaluateObjectiveCompletion(
  iteration: PersistedAutonomousLoopIteration,
  criteria: AutonomousLoopObjectiveCompletionCriteria | null,
): AutonomousLoopObjectiveCompletionEvidence {
  const changedArtifacts = dedupeStrings(iteration.changedArtifacts)
  const passedEvaluationScenarios = dedupeStrings(
    iteration.evaluations
      .filter((record) => record.exitCode === 0)
      .map((record) => record.scenarioName),
  )
  const passedVerificationCommands = dedupeCommandMatrix(
    iteration.verification
      .filter((record) => record.exitCode === 0)
      .map((record) => record.command),
  )

  if (!criteria) {
    return {
      satisfied: false,
      changedArtifacts,
      passedEvaluationScenarios,
      passedVerificationCommands,
      missingChangedArtifacts: [],
      missingEvaluationScenarios: [],
      missingVerificationCommands: [],
      checkedAt: iteration.completedAt,
    }
  }

  const missingChangedArtifacts = (criteria.changedArtifacts ?? []).filter(
    (artifact) => !changedArtifacts.includes(artifact),
  )
  const missingEvaluationScenarios = (criteria.evaluationScenarios ?? []).filter(
    (scenarioName) => !passedEvaluationScenarios.includes(scenarioName),
  )
  const missingVerificationCommands = normalizeVerificationCommandCriteria(
    criteria.verificationCommands,
  ).filter(
    (command) => !passedVerificationCommands.some((passedCommand) => areCommandsEqual(passedCommand, command)),
  )

  return {
    satisfied:
      iteration.decision === "promoted" &&
      missingChangedArtifacts.length === 0 &&
      missingEvaluationScenarios.length === 0 &&
      missingVerificationCommands.length === 0,
    changedArtifacts,
    passedEvaluationScenarios,
    passedVerificationCommands,
    missingChangedArtifacts,
    missingEvaluationScenarios,
    missingVerificationCommands,
    checkedAt: iteration.completedAt,
  }
}

function doesObjectiveCompletionEvidenceSatisfyCriteria(
  criteria: AutonomousLoopObjectiveCompletionCriteria | null,
  evidence: AutonomousLoopObjectiveCompletionEvidence | null,
) {
  if (!criteria || !evidence) {
    return false
  }

  const missingChangedArtifacts = (criteria.changedArtifacts ?? []).filter(
    (artifact) => !evidence.changedArtifacts.includes(artifact),
  )
  const missingEvaluationScenarios = (criteria.evaluationScenarios ?? []).filter(
    (scenarioName) => !evidence.passedEvaluationScenarios.includes(scenarioName),
  )
  const missingVerificationCommands = normalizeVerificationCommandCriteria(
    criteria.verificationCommands,
  ).filter(
    (command) =>
      !evidence.passedVerificationCommands.some((passedCommand) => areCommandsEqual(passedCommand, command)),
  )

  return (
    evidence.satisfied === true &&
    missingChangedArtifacts.length === 0 &&
    missingEvaluationScenarios.length === 0 &&
    missingVerificationCommands.length === 0
  )
}

function areCommandsEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function formatCommandLabel(command: string[]) {
  return command.join(" ")
}

function formatAutonomousLoopStatus(state: PersistedAutonomousLoopState): AutonomousLoopStatus {
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
