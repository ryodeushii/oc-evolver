import { access } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

type InstalledEvaluationResult = {
  scenarioName: string
  resultDir: string
  workspaceRoot: string
  globalOpencodeRoot: string
  stdout: string
  stderr: string
  exitCode: number
}

async function loadInstalledEvaluationRunner() {
  try {
    const module = await import("../../scripts/run-installed-eval.ts") as {
      runInstalledEvaluationScenario?: (input: {
        repoRoot: string
        scenarioName: string
        timestamp?: string
      }) => Promise<InstalledEvaluationResult>
    }

    return module.runInstalledEvaluationScenario
  } catch {
    return undefined
  }
}

describe("installed server eval harness", () => {
  test("runs smoke through the installed server path and uses only global runtime roots", async () => {
    const runInstalledEvaluationScenario = await loadInstalledEvaluationRunner()

    expect(typeof runInstalledEvaluationScenario).toBe("function")

    if (!runInstalledEvaluationScenario) {
      return
    }

    const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
    const result = await runInstalledEvaluationScenario({
      repoRoot,
      scenarioName: "smoke",
      timestamp: "integration-installed-smoke",
    })

    expect(result.scenarioName).toBe("smoke")
    expect(result.exitCode).toBe(0)
    expect(result.resultDir).toContain("installed-smoke")

    await access(join(result.globalOpencodeRoot, "oc-evolver"))
    await access(join(result.globalOpencodeRoot, "skills"))
    await access(join(result.globalOpencodeRoot, "agent"))
    await access(join(result.globalOpencodeRoot, "commands"))
    await access(join(result.globalOpencodeRoot, "memory"))

    await expect(access(join(result.workspaceRoot, ".opencode/oc-evolver"))).rejects.toBeDefined()
    await expect(access(join(result.workspaceRoot, ".opencode/skills"))).rejects.toBeDefined()
    await expect(access(join(result.workspaceRoot, ".opencode/agent"))).rejects.toBeDefined()
    await expect(access(join(result.workspaceRoot, ".opencode/commands"))).rejects.toBeDefined()
    await expect(access(join(result.workspaceRoot, ".opencode/memory"))).rejects.toBeDefined()
    await expect(access(join(result.workspaceRoot, ".opencode/plugins/oc-evolver.ts"))).rejects.toBeDefined()
  }, 120_000)
})
