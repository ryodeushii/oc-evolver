import runtimeContract from "../eval/runtime-contract.json"
import {
  DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS,
  resolveAutonomousLoopSchedulePolicy,
  runAutonomousIteration,
  startAutonomousLoopWorker,
  type AutonomousLoopWorkerConfig,
} from "../src/kernel/autonomous-loop.ts"
import { runEvaluationScenario } from "./run-eval.ts"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const args = process.argv.slice(2)

function readFlag(name: string) {
  const index = args.indexOf(name)

  if (index === -1) {
    return null
  }

  return args[index + 1] ?? null
}

function hasFlag(name: string) {
  return args.includes(name)
}

function readListFlag(name: string) {
  const value = readFlag(name)

  if (!value) {
    return []
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function resolveGlobalPluginFilePath() {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")

  return join(configHome, "opencode", "plugins", "oc-evolver.ts")
}

const repoRoot = resolve(readFlag("--repo") ?? process.cwd())
const prompt =
  readFlag("--prompt") ??
  "Review the current project state, make one concrete improvement, and leave the workspace in a verified state."
const workerRequested = hasFlag("--worker")
const schedulePolicy = resolveAutonomousLoopSchedulePolicy({
  workerRequested,
  intervalMs: Number(readFlag("--interval-ms") ?? "0"),
})
const requestedEvaluationScenarios = readListFlag("--eval")
const verificationCommands = readListFlag("--verify").map((entry) => entry.split(" ").filter(Boolean))
const workerConfig: AutonomousLoopWorkerConfig = {
  repoRoot,
  pluginFilePath: resolveGlobalPluginFilePath(),
  intervalMs: schedulePolicy.intervalMs,
  verificationCommands: verificationCommands.length > 0 ? verificationCommands : undefined,
  evaluationScenarios:
    requestedEvaluationScenarios.length > 0
      ? requestedEvaluationScenarios
      : DEFAULT_AUTONOMOUS_LOOP_EVALUATION_SCENARIOS,
}

if (schedulePolicy.runInWorker) {
  const worker = startAutonomousLoopWorker(workerConfig)

  worker.on("message", (message) => {
    console.log(JSON.stringify(message))
  })
  worker.on("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
} else {
  const result = await runAutonomousIteration({
    repoRoot: workerConfig.repoRoot,
    pluginFilePath: workerConfig.pluginFilePath,
    runtimeContract,
    prompt,
    verificationCommands: workerConfig.verificationCommands,
    evaluationScenarios: workerConfig.evaluationScenarios,
    runEvaluationScenario: ({ repoRoot, scenarioName }) =>
      runEvaluationScenario({
        repoRoot,
        scenarioName,
      }),
  })

  console.log(JSON.stringify(result, null, 2))
}
