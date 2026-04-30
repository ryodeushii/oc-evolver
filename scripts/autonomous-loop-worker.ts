import runtimeContract from "../eval/runtime-contract.json"
import {
  runAutonomousIteration,
  type AutonomousLoopWorkerConfig,
} from "../src/kernel/autonomous-loop.ts"
import { runEvaluationScenario } from "./run-eval.ts"

import { isMainThread, parentPort, workerData } from "node:worker_threads"

async function runWorkerIteration(config: AutonomousLoopWorkerConfig) {
  const result = await runAutonomousIteration({
    repoRoot: config.repoRoot,
    pluginFilePath: config.pluginFilePath,
    runtimeContract,
    prompt: config.prompt,
    verificationCommands: config.verificationCommands,
    evaluationScenarios: config.evaluationScenarios,
    runEvaluationScenario: ({ repoRoot, scenarioName }) =>
      runEvaluationScenario({
        repoRoot,
        scenarioName,
      }),
  })

  parentPort?.postMessage({
    type: "iteration",
    result,
  })
}

if (!isMainThread) {
  const config = workerData as AutonomousLoopWorkerConfig

  const runOnce = async () => {
    try {
      await runWorkerIteration(config)
    } catch (error) {
      parentPort?.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await runOnce()

  if (config.intervalMs > 0) {
    setInterval(() => {
      void runOnce()
    }, config.intervalMs)
  }
}
