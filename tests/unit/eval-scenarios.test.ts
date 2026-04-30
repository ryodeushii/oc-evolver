import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  runEvaluationScenario,
  type EvalCommandResult,
} from "../../scripts/run-eval.ts"

describe("evaluation scenarios", () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "oc-evolver-eval-scenarios-"))

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
      JSON.stringify(
        {
          skills: {},
          agents: {},
          commands: {},
          memories: {},
          quarantine: {},
          currentRevision: null,
          pendingRevision: null,
        },
        null,
        2,
      ),
    )
    await writeFile(join(repoRoot, "eval/fixtures/base/README.md"), "TODO: base fixture\n")
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test("reuse-skill scenario continues the same session across turns and verifies persisted artifacts", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/reuse-skill.md"),
      [
        "Create the fixture skill and agent.",
        "---",
        "Apply the fixture skill to README.md.",
        "---",
        "Run the fixture agent against README.md.",
      ].join("\n"),
    )

    const calls: Array<{ workspaceRoot: string; command: string[]; prompt: string }> = []

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "reuse-skill",
      timestamp: "2026-04-30T14-00-00.000Z",
      executeCommand: async ({ workspaceRoot, command, prompt }) => {
        calls.push({ workspaceRoot, command, prompt })

        await mkdir(join(workspaceRoot, ".opencode/skills/fixture-refactor/scripts"), {
          recursive: true,
        })
        await mkdir(join(workspaceRoot, ".opencode/agent"), { recursive: true })
        await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })

        if (calls.length === 1) {
          await writeFile(
            join(workspaceRoot, ".opencode/skills/fixture-refactor/SKILL.md"),
            "---\nname: fixture-refactor\ndescription: Rewrite TODO markers\n---\n\nUse the helper.\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/skills/fixture-refactor/scripts/rewrite.py"),
            "print('rewrite')\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/agent/fixture-reviewer.md"),
            "---\ndescription: Review markdown updates\nmode: subagent\n---\n\nReview markdown changes.\n",
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
                    helperPaths: [".opencode/skills/fixture-refactor/scripts/rewrite.py"],
                    revisionID: "rev-skill",
                    contentHash: "a".repeat(64),
                  },
                },
                agents: {
                  "fixture-reviewer": {
                    kind: "agent",
                    name: "fixture-reviewer",
                    nativePath: ".opencode/agent/fixture-reviewer.md",
                    revisionID: "rev-agent",
                    contentHash: "b".repeat(64),
                  },
                },
                commands: {},
                memories: {},
                quarantine: {},
                currentRevision: "rev-agent",
                pendingRevision: null,
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              JSON.stringify({ action: "write_skill", status: "success" }),
              JSON.stringify({ action: "write_agent", status: "success" }),
            ].join("\n") + "\n",
          )

          return {
            stdout: [
              '{"type":"step_start","sessionID":"ses-reuse-1"}',
              '{"type":"text","sessionID":"ses-reuse-1","text":"created artifacts"}',
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        expect(command).toContain("--session")
        expect(command).toContain("ses-reuse-1")

        if (calls.length === 2) {
          await writeFile(join(workspaceRoot, "README.md"), "NOTE: base fixture\n")
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              JSON.stringify({ action: "write_skill", status: "success" }),
              JSON.stringify({ action: "write_agent", status: "success" }),
              JSON.stringify({ action: "apply_skill", status: "success" }),
            ].join("\n") + "\n",
          )

          return {
            stdout: [
              '{"type":"step_start","sessionID":"ses-reuse-1"}',
              '{"type":"text","sessionID":"ses-reuse-1","text":"applied skill"}',
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
          [
            JSON.stringify({ action: "write_skill", status: "success" }),
            JSON.stringify({ action: "write_agent", status: "success" }),
            JSON.stringify({ action: "apply_skill", status: "success" }),
            JSON.stringify({ action: "run_agent", status: "success" }),
          ].join("\n") + "\n",
        )

        return {
          stdout: [
            '{"type":"step_start","sessionID":"ses-reuse-1"}',
            '{"type":"text","sessionID":"ses-reuse-1","text":"ran agent"}',
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    expect(calls).toHaveLength(3)
    expect(calls[0]?.command).not.toContain("--session")
    expect(calls[1]?.command).toContain("--session")
    expect(calls[2]?.command).toContain("--session")
    expect(calls[1]?.prompt).toContain("Apply the fixture skill")
    expect(calls[2]?.prompt).toContain("Run the fixture agent")

    const turnsJson = JSON.parse(
      await readFile(join(result.resultDir, "turns.json"), "utf8"),
    ) as Array<{ turnNumber: number; sessionID: string | null; exitCode: number; command: string[] }>
    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }

    expect(turnsJson).toHaveLength(3)
    expect(turnsJson[1]).toMatchObject({
      turnNumber: 2,
      sessionID: "ses-reuse-1",
      exitCode: 0,
    })
    expect(turnsJson[1]?.command).toContain("--session")
    expect(resultJson.turnCount).toBe(3)
    expect(resultJson.changedFiles).toContain("README.md")
    expect(resultJson.changedFiles).toContain(".opencode/skills/fixture-refactor/SKILL.md")
    expect(resultJson.changedFiles).toContain(".opencode/agent/fixture-reviewer.md")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/audit.ndjson")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/registry.json")
  })

  test("policy-deny scenario fails if the protected plugin file changes", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/policy-deny.md"),
      "Attempt the protected plugin mutation and report the denial.\n",
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "policy-deny",
        timestamp: "2026-04-30T14-05-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/plugins/oc-evolver.ts"),
            "console.log('tampered')\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"policy_denied","status":"failure"}\n',
          )

          return {
            stdout: '{"type":"text","text":"mutation denied"}',
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/protected plugin file changed/i)
  })

  test("invalid-artifact scenario seeds a broken skill and captures quarantine metadata", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/invalid-artifact.md"),
      "Use oc-evolver to validate the current registry and report invalid artifacts.\n",
    )

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "invalid-artifact",
      timestamp: "2026-04-30T14-10-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        const seededInvalidSkill = await readFile(
          join(workspaceRoot, ".opencode/skills/broken-skill/SKILL.md"),
          "utf8",
        )

        expect(seededInvalidSkill).toContain("name: broken-skill")
        expect(seededInvalidSkill).not.toContain("description:")

        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
          JSON.stringify(
            {
              skills: {},
              agents: {},
              commands: {},
              memories: {},
              quarantine: {
                ".opencode/skills/broken-skill/SKILL.md": {
                  kind: "skill",
                  reason: "invalid skill document: description is required in frontmatter",
                  failureClass: "invalid_artifact",
                },
              },
              currentRevision: null,
              pendingRevision: null,
            },
            null,
            2,
          ),
        )
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
          '{"action":"validate","status":"failure","failureClass":"invalid_artifact","target":".opencode/skills/broken-skill/SKILL.md"}\n',
        )

        return {
          stdout: '{"type":"text","text":"found invalid artifact","sessionID":"ses-invalid-1"}',
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const registryJson = JSON.parse(
      await readFile(join(result.resultDir, "registry.json"), "utf8"),
    ) as {
      quarantine: Record<string, { failureClass: string }>
    }
    const auditLog = await readFile(join(result.resultDir, "audit.ndjson"), "utf8")

    expect(registryJson.quarantine[".opencode/skills/broken-skill/SKILL.md"]).toMatchObject({
      failureClass: "invalid_artifact",
    })
    expect(auditLog).toContain("invalid_artifact")
  })
})
