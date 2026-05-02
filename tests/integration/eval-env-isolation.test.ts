import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

import { runEvaluationScenario } from "../../scripts/run-eval.ts"

describe("runEvaluationScenario", () => {
  test(
    "isolates objective-memory-evidence from installed global plugin config",
    async () => {
      const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
      const tempHome = await Bun.$`mktemp -d ${join(tmpdir(), "oc-evolver-eval-home-XXXXXX")}`.text()
      const homeRoot = tempHome.trim()
      const xdgConfigHome = join(homeRoot, ".config")
      const opencodeConfigRoot = join(xdgConfigHome, "opencode")
      const originalHome = process.env.HOME
      const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

      await mkdir(opencodeConfigRoot, { recursive: true })
      await writeFile(
        join(opencodeConfigRoot, "opencode.json"),
        `${JSON.stringify({ plugin: [repoRoot] }, null, 2)}\n`,
        "utf8",
      )

      process.env.HOME = homeRoot
      process.env.XDG_CONFIG_HOME = xdgConfigHome

      try {
        const result = await runEvaluationScenario({
          repoRoot,
          scenarioName: "objective-memory-evidence",
          timestamp: "integration-objective-memory-evidence-isolated",
        })

        expect(result.exitCode).toBe(0)
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = originalHome
        }

        if (originalXdgConfigHome === undefined) {
          delete process.env.XDG_CONFIG_HOME
        } else {
          process.env.XDG_CONFIG_HOME = originalXdgConfigHome
        }
      }
    },
    120_000,
  )
})
