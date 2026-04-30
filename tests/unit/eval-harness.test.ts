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

  test("runEvaluationScenario skips walking ignored install-noise directories", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/noise.md"),
      "Exercise harness diffing without reading ignored install-noise files.\n",
    )

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "noise",
      timestamp: "2026-04-30T12-05-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, ".opencode/node_modules/huge-package"), {
          recursive: true,
        })
        await writeFile(
          join(workspaceRoot, ".opencode/node_modules/huge-package/index.js"),
          "console.log('ignored')\n",
        )
        await writeFile(join(workspaceRoot, "README.md"), "NOTE: changed\n")

        return {
          stdout: '{"type":"text","text":"noise ok"}',
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(
      await readFile(join(result.resultDir, "result.json"), "utf8"),
    ) as { changedFiles: string[] }

    expect(resultJson.changedFiles).toEqual(["README.md"])
  })
  test("runEvaluationScenario rejects create-skill artifacts that miss the canonical helper path", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/create-skill.md"),
      "Create the fixture skill and helper.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "create-skill",
        timestamp: "2026-04-30T12-10-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/skills/fixture-refactor"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/skills/fixture-refactor/SKILL.md"),
            "---\nname: fixture-refactor\ndescription: Rewrite TODO markers\n---\n\nUse the helper.\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/skills/fixture-refactor/fixture_refactor.py"),
            "print('rewrite')\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"write_skill","status":"success"}\n',
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify(
              {
                skills: {
                  "fixture-refactor": {
                    kind: "skill",
                    name: "fixture-refactor",
                    nativePath: ".opencode/skills/fixture-refactor/SKILL.md",
                    helperPaths: [".opencode/skills/fixture-refactor/fixture_refactor.py"],
                    revisionID: "rev-skill",
                    contentHash: "a".repeat(64),
                  },
                },
                agents: {},
                commands: {},
                quarantine: {},
                currentRevision: "rev-skill",
              },
              null,
              2,
            ),
          )

          return {
            stdout: '{"type":"text","text":"created skill"}',
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/rewrite_todo_to_note.py/i)
  })

  test("runEvaluationScenario rejects create-skill artifacts without a write_skill audit event", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/create-skill.md"),
      "Create the fixture skill and helper.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "create-skill",
        timestamp: "2026-04-30T12-11-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/skills/fixture-refactor/scripts"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/skills/fixture-refactor/SKILL.md"),
            "---\nname: fixture-refactor\ndescription: Rewrite TODO markers\n---\n\nUse the helper.\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/skills/fixture-refactor/scripts/rewrite_todo_to_note.py"),
            "print('rewrite')\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"write_memory","status":"success"}\n',
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({
              skills: {
                "fixture-refactor": {
                  kind: "skill",
                  name: "fixture-refactor",
                  nativePath: ".opencode/skills/fixture-refactor/SKILL.md",
                  helperPaths: [".opencode/skills/fixture-refactor/scripts/rewrite_todo_to_note.py"],
                  revisionID: "rev-skill",
                  contentHash: "a".repeat(64),
                },
              },
              agents: {},
              commands: {},
              quarantine: {},
              currentRevision: "rev-skill",
            }, null, 2),
          )

          return { stdout: '{"type":"text","text":"created skill"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/write_skill/i)
  })

  test("runEvaluationScenario rejects memory-guided-write artifacts that create repo-local markdown notes", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/memory-guided-write.md"),
      "Create a routing memory profile.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "memory-guided-write",
        timestamp: "2026-04-30T12-12-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/memory/research-routing.md"),
            "---\nname: research-routing\ndescription: Route durable notes\nstorage_mode: memory-and-artifact\n---\n",
          )
          await writeFile(join(workspaceRoot, "policy.md"), "do not commit\n")
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"write_memory","status":"success"}\n',
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({
              skills: {},
              agents: {},
              commands: {},
              memories: {
                "research-routing": {
                  kind: "memory",
                  name: "research-routing",
                  nativePath: ".opencode/memory/research-routing.md",
                  revisionID: "rev-memory",
                  contentHash: "b".repeat(64),
                },
              },
              quarantine: {},
              currentRevision: "rev-memory",
            }, null, 2),
          )

          return { stdout: '{"type":"text","text":"created memory"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/repo-local markdown/i)
  })

  test("runEvaluationScenario rejects artifact-only-deny artifacts without a policy_denied audit event", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/artifact-only-deny.md"),
      "Apply artifact-only memory and attempt a blocked write.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "artifact-only-deny",
        timestamp: "2026-04-30T12-13-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/memory/artifact-only-session.md"),
            "---\nname: artifact-only-session\ndescription: artifact only\nstorage_mode: artifact-only\n---\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/sessions/session-1.json"),
            JSON.stringify({ memories: { "artifact-only-session": { storageMode: "artifact-only" } } }, null, 2),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              '{"action":"write_memory","status":"success"}',
              '{"action":"apply_memory","status":"success"}',
            ].join("\n") + "\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({ skills: {}, agents: {}, commands: {}, memories: {}, quarantine: {}, currentRevision: "rev-artifact" }, null, 2),
          )

          return { stdout: '{"type":"text","text":"denied write"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/policy_denied/i)
  })

  test("runEvaluationScenario rejects rollback artifacts when the command file is not restored", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/rollback.md"),
      "Create two command revisions and roll back.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "rollback",
        timestamp: "2026-04-30T12-14-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/commands/review-markdown.md"),
            "---\ndescription: Second review flow\n---\n\nReview README.md twice.\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"rollback","status":"success"}\n',
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({ skills: {}, agents: {}, commands: {}, memories: {}, quarantine: {}, currentRevision: "rev-first" }, null, 2),
          )

          return { stdout: '{"type":"text","text":"rolled back"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/restored|first command body/i)
  })


  test("runEvaluationScenario accepts artifact-only-deny artifacts when policy_denied is recorded as a failure", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/artifact-only-deny.md"),
      "Apply artifact-only memory and attempt a blocked write.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "artifact-only-deny",
        timestamp: "2026-04-30T12-13-30.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/memory/artifact-only-session.md"),
            "---\nname: artifact-only-session\ndescription: artifact only\nstorage_mode: artifact-only\n---\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/sessions/session-1.json"),
            JSON.stringify({ memories: { "artifact-only-session": { storageMode: "artifact-only" } } }, null, 2),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              '{"action":"write_memory","status":"success"}',
              '{"action":"apply_memory","status":"success"}',
              '{"action":"policy_denied","status":"failure","failureClass":"policy_denied"}',
            ].join("\n") + "\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({ skills: {}, agents: {}, commands: {}, memories: {}, quarantine: {}, currentRevision: "rev-artifact" }, null, 2),
          )

          return { stdout: '{"type":"text","text":"denied write"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).resolves.toMatchObject({ scenarioName: "artifact-only-deny", exitCode: 0 })
  })

  test("runEvaluationScenario rejects artifact-only-deny artifacts without an apply_memory audit event", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/artifact-only-deny.md"),
      "Apply artifact-only memory and attempt a blocked write.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "artifact-only-deny",
        timestamp: "2026-04-30T12-13-40.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/memory/artifact-only-session.md"),
            "---\nname: artifact-only-session\ndescription: artifact only\nstorage_mode: artifact-only\n---\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/sessions/session-1.json"),
            JSON.stringify({ memories: { "artifact-only-session": { storageMode: "artifact-only" } } }, null, 2),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              '{"action":"write_memory","status":"success"}',
              '{"action":"policy_denied","status":"failure","failureClass":"policy_denied"}',
            ].join("\n") + "\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({ skills: {}, agents: {}, commands: {}, memories: {}, quarantine: {}, currentRevision: "rev-artifact" }, null, 2),
          )

          return { stdout: '{"type":"text","text":"denied write"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/apply_memory/i)
  })

  test("runEvaluationScenario rejects memory-guided-write artifacts without a registry memory entry", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/memory-guided-write.md"),
      "Create a routing memory profile.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "memory-guided-write",
        timestamp: "2026-04-30T12-12-30.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/memory/research-routing.md"),
            "---\nname: research-routing\ndescription: Route durable notes\nstorage_mode: memory-and-artifact\n---\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"write_memory","status":"success"}\n',
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({ skills: {}, agents: {}, commands: {}, memories: {}, quarantine: {}, currentRevision: "rev-memory" }, null, 2),
          )

          return { stdout: '{"type":"text","text":"created memory"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/research-routing/i)
  })

  test("runEvaluationScenario rejects rollback artifacts when registry currentRevision is not restored", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/rollback.md"),
      "Create two command revisions and roll back.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "rollback",
        timestamp: "2026-04-30T12-14-30.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/commands/review-markdown.md"),
            "---\ndescription: First review flow\n---\n\nReview README.md once.\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"rollback","status":"success"}\n',
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({ skills: {}, agents: {}, commands: {}, memories: {}, quarantine: {}, currentRevision: "rev-second" }, null, 2),
          )

          return { stdout: '{"type":"text","text":"rolled back"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/currentRevision|restored revision/i)
  })


  test("runEvaluationScenario accepts rollback artifacts when currentRevision matches the restored revision id", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/rollback.md"),
      "Create two command revisions and roll back.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "rollback",
        timestamp: "2026-04-30T12-14-40.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/commands/review-markdown.md"),
            "---\ndescription: First review flow\n---\n\nReview README.md once.\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"rollback","status":"success","revisionID":"restored-rev","rolledBackRevisionID":"replaced-rev"}\n',
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({ skills: {}, agents: {}, commands: {}, memories: {}, quarantine: {}, currentRevision: "restored-rev" }, null, 2),
          )

          return { stdout: '{"type":"text","text":"rolled back"}', stderr: "", exitCode: 0 } satisfies EvalCommandResult
        },
      }),
    ).resolves.toMatchObject({ scenarioName: "rollback", exitCode: 0 })
  })

})
