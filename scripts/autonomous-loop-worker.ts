import runtimeContract from "../eval/runtime-contract.json"
import {
  getAutonomousLoopStatus,
  runAutonomousIteration,
  type AutonomousLoopWorkerConfig,
} from "../src/kernel/autonomous-loop.ts"
import { runEvaluationScenario } from "./run-eval.ts"

import { isMainThread, parentPort, workerData } from "node:worker_threads"

async function runWorkerIteration(config: AutonomousLoopWorkerConfig) {
  const status = await getAutonomousLoopStatus({
    pluginFilePath: config.pluginFilePath,
    runtimeContract,
  })

  if (!status.config.enabled || status.config.paused) {
    parentPort?.postMessage({
      type: "iteration",
      result: {
        decision: "no_pending_revision",
        sessionID: status.lastSessionID,
        pendingRevisionID: null,
        promotedRevisionID: null,
        rejectionReason: !status.config.enabled ? "autonomous loop disabled" : "autonomous loop paused",
      },
    })

    return
  }

  const result = await runAutonomousIteration({
    repoRoot: config.repoRoot,
    pluginFilePath: config.pluginFilePath,
    runtimeContract,
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
  let running = false

  const runOnce = async () => {
    if (running) {
      return
    }

    running = true

    try {
      await runWorkerIteration(config)
    } catch (error) {
      parentPort?.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
    }
  }

  await runOnce()

  if (config.intervalMs > 0) {
    setInterval(() => {
      void runOnce()
    }, config.intervalMs)
  }
}
