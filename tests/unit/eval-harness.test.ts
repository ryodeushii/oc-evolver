import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

import {
  runEvaluationScenario,
  type EvalCommandResult,
} from "../../scripts/run-eval.ts"
import { syncPluginIntoFixture } from "../../scripts/sync-plugin-into-fixture.ts"

describe("evaluation harness", () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "oc-evolver-eval-harness-"))

    await mkdir(join(repoRoot, "src"), { recursive: true })
    await mkdir(join(repoRoot, "eval/fixtures/base/.opencode/oc-evolver"), {
      recursive: true,
    })
    await mkdir(join(repoRoot, "eval/scenarios"), { recursive: true })

    await writeFile(
      join(repoRoot, "src/oc-evolver.ts"),
      'export const OCEvolverPlugin = async () => ({ tool: {} })\n',
    )
    await writeFile(
      join(repoRoot, "eval/fixtures/base/.opencode/oc-evolver/registry.json"),
      JSON.stringify({ skills: {}, agents: {}, commands: {}, currentRevision: null }, null, 2),
    )
    await writeFile(join(repoRoot, "eval/fixtures/base/README.md"), "TODO: base fixture\n")
    await writeFile(
      join(repoRoot, "eval/scenarios/smoke.md"),
      "Use the oc-evolver plugin to report its status.\n",
    )
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test("syncPluginIntoFixture writes a loadable plugin bridge into the base fixture", async () => {
    await syncPluginIntoFixture({ repoRoot })

    const syncedPluginPath = join(
      repoRoot,
      "eval/fixtures/base/.opencode/plugins/oc-evolver.ts",
    )
    const syncedPlugin = await readFile(syncedPluginPath, "utf8")

    expect(syncedPlugin).toContain("OCEvolverPlugin as server")
    expect(syncedPlugin).toContain(pathToFileURL(join(repoRoot, "src/oc-evolver.ts")).href)
  })

  test("runEvaluationScenario creates a fresh workspace and captures machine-readable results", async () => {
    const calls: Array<{ workspaceRoot: string; prompt: string; command: string[] }> = []

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "smoke",
      timestamp: "2026-04-30T12-00-00.000Z",
      executeCommand: async ({ workspaceRoot, prompt, command }) => {
        calls.push({ workspaceRoot, prompt, command })

        await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
          '{"action":"smoke","status":"success"}\n',
        )
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
          JSON.stringify(
            {
              skills: {
                "fixture-refactor": {
                  kind: "skill",
                },
              },
              agents: {},
              commands: {},
              currentRevision: "rev-1",
            },
            null,
            2,
          ),
        )
        await mkdir(join(workspaceRoot, ".opencode/node_modules/noise"), { recursive: true })
        await writeFile(
          join(workspaceRoot, ".opencode/node_modules/noise/index.js"),
          "console.log('noise')\n",
        )
        await writeFile(
          join(workspaceRoot, ".opencode/package.json"),
          '{"name":"fixture-install-noise"}\n',
        )
        await writeFile(
          join(workspaceRoot, ".opencode/package-lock.json"),
          '{"lockfileVersion":3}\n',
        )
        await writeFile(join(workspaceRoot, "README.md"), "NOTE: updated by smoke eval\n")

        return {
          stdout: [
            '{"type":"step_start"}',
            '{"type":"tool_use","tool":"evolver_status"}',
            '{"type":"text","text":"smoke ok"}',
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain("report its status")
    expect(calls[0]?.workspaceRoot).not.toBe(join(repoRoot, "eval/fixtures/base"))
    expect(calls[0]?.command).toContain("run")

    const syncedPluginPath = join(
      repoRoot,
      "eval/fixtures/base/.opencode/plugins/oc-evolver.ts",
    )
    const resultJsonPath = join(result.resultDir, "result.json")
    const responseJsonPath = join(result.resultDir, "response.json")
    const auditPath = join(result.resultDir, "audit.ndjson")
    const registryPath = join(result.resultDir, "registry.json")

    expect(await Bun.file(syncedPluginPath).exists()).toBe(true)
    expect(await Bun.file(resultJsonPath).exists()).toBe(true)
    expect(await Bun.file(responseJsonPath).exists()).toBe(true)
    expect(await Bun.file(auditPath).exists()).toBe(true)
    expect(await Bun.file(registryPath).exists()).toBe(true)

    const resultJson = JSON.parse(await readFile(resultJsonPath, "utf8")) as {
      scenarioName: string
      exitCode: number
      changedFiles: string[]
    }

    expect(resultJson.scenarioName).toBe("smoke")
    expect(resultJson.exitCode).toBe(0)
    expect(resultJson.changedFiles).toContain("README.md")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/audit.ndjson")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/registry.json")
    expect(resultJson.changedFiles).not.toContain(".opencode/node_modules/noise/index.js")
    expect(resultJson.changedFiles).not.toContain(".opencode/package.json")
    expect(resultJson.changedFiles).not.toContain(".opencode/package-lock.json")

    const responseJson = JSON.parse(await readFile(responseJsonPath, "utf8")) as Array<{
      type: string
      tool?: string
      text?: string
    }>
    const registryJson = JSON.parse(await readFile(registryPath, "utf8")) as {
      skills: Record<string, unknown>
      currentRevision: string | null
    }

    expect(responseJson).toHaveLength(3)
    expect(responseJson[1]).toMatchObject({ type: "tool_use", tool: "evolver_status" })
    expect(responseJson[2]).toMatchObject({ type: "text", text: "smoke ok" })
    expect(registryJson.currentRevision).toBe("rev-1")
    expect(registryJson.skills).toHaveProperty("fixture-refactor")
  })
})
