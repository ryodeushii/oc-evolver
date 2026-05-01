import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  DEFAULT_SCENARIOS,
  runEvaluationScenario,
  type EvalCommandResult,
} from "../../scripts/run-eval.ts"

const AUTONOMOUS_RUN_OBJECTIVE_PROMPT =
  'Make exactly one mutation by calling evolver_write_memory with memoryName "autonomous-evidence-memory" and document "---\\nname: autonomous-evidence-memory\\ndescription: Autonomous evaluation evidence memory.\\n---\\n\\nAutonomous evaluation evidence memory.". After the write succeeds, respond with exactly one short confirmation sentence. Do not call evolver_autonomous_run. Do not call status tools before the write.'
const AUTONOMOUS_RUN_CONFIGURE_INPUT = {
  intervalMs: 0,
  verificationCommands: [],
  evaluationScenarios: ["smoke"],
  failurePolicy: {
    maxConsecutiveFailures: 3,
    escalationAction: "pause_loop",
  },
  objectives: [
    {
      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
      completionCriteria: {
        changedArtifacts: ["memory:autonomous-evidence-memory"],
        evaluationScenarios: ["objective-memory-evidence"],
      },
    },
  ],
  replaceObjectives: true,
  enabled: true,
  paused: false,
} as const

function buildToolEvent(tool: string, sessionID: string, input?: unknown, output?: unknown) {
  return JSON.stringify(
    input === undefined && output === undefined
      ? { type: "tool", tool, sessionID }
      : {
          type: "tool",
          tool,
          sessionID,
          state: {
            ...(input === undefined ? {} : { input }),
            ...(output === undefined ? {} : { output }),
          },
        },
  )
}

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

  test("autonomous-run scenario is part of the default sweep and captures loop state artifacts", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-run.md", import.meta.url), "utf8"),
    )

    await writeFile(
      join(repoRoot, "eval/scenarios/objective-memory-evidence.md"),
      await readFile(new URL("../../eval/scenarios/objective-memory-evidence.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "autonomous-run",
      timestamp: "2026-04-30T14-15-00.000Z",
      executeCommand: async ({ workspaceRoot, prompt }) => {
        executionCount += 1

        if (executionCount === 1) {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/memory/autonomous-evidence-memory.md"),
            "---\nname: autonomous-evidence-memory\ndescription: Evidence fixture for autonomous eval coverage.\n---\n\n# Autonomous Evidence Memory\n\nThis artifact exists to verify autonomous completion evidence and promotion behavior.\n",
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
            JSON.stringify(
              {
                config: {
                  enabled: true,
                  paused: false,
                  intervalMs: 0,
                  verificationCommands: [],
                  evaluationScenarios: ["smoke"],
                  failurePolicy: {
                    maxConsecutiveFailures: 3,
                    escalationAction: "pause_loop",
                    lastEscalationReason: null,
                  },
                },
                lastSessionID: "ses-auto-1",
                latestLearning: {
                  summary: "The last autonomous iteration was promoted at revision rev-auto-1.",
                  remainingObjectives: [],
                },
                objectives: [
                  {
                    prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                    status: "completed",
                    completionCriteria: {
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      evaluationScenarios: ["objective-memory-evidence"],
                    },
                    lastCompletionEvidence: {
                      satisfied: true,
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                      missingChangedArtifacts: [],
                      missingEvaluationScenarios: [],
                      checkedAt: new Date(0).toISOString(),
                    },
                    attempts: 1,
                    consecutiveFailures: 0,
                    updatedAt: new Date(0).toISOString(),
                    lastSessionID: "ses-auto-1",
                    lastDecision: "promoted",
                    lastEscalationReason: null,
                  },
                ],
                iterations: [
                  {
                    decision: "promoted",
                    changedArtifacts: ["memory:autonomous-evidence-memory"],
                    evaluations: [
                      {
                        scenarioName: "smoke",
                        exitCode: 0,
                      },
                      {
                        scenarioName: "objective-memory-evidence",
                        exitCode: 0,
                      },
                    ],
                  },
                ],
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify(
              {
                skills: {},
                agents: {},
                commands: {},
                memories: {
                  "autonomous-evidence-memory": {
                    kind: "memory",
                    name: "autonomous-evidence-memory",
                    nativePath: ".opencode/memory/autonomous-evidence-memory.md",
                    revisionID: "rev-auto-1",
                    contentHash: "a".repeat(64),
                  },
                },
                quarantine: {},
                currentRevision: "rev-auto-1",
                pendingRevision: null,
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            '{"action":"promote","status":"success","revisionID":"rev-auto-1"}\n',
          )

          return {
            stdout: [
                buildToolEvent("evolver_autonomous_configure", "ses-auto-1", AUTONOMOUS_RUN_CONFIGURE_INPUT),
                buildToolEvent("evolver_autonomous_start", "ses-auto-1", {}),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        expect(prompt).toContain("Turn 2")

        return {
          stdout: [
            '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-auto-1"}',
            '{"type":"tool","tool":"evolver_status","sessionID":"ses-auto-1"}',
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }
    const turns = JSON.parse(await readFile(join(result.resultDir, "turns.json"), "utf8")) as Array<{
      sessionID: string | null
    }>
     
    expect(DEFAULT_SCENARIOS).toContain("autonomous-run")
    expect(resultJson.turnCount).toBe(2)
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/autonomous-loop.json")
    expect(resultJson.changedFiles).toContain(".opencode/memory/autonomous-evidence-memory.md")
    expect(turns).toHaveLength(2)
    expect(turns[0]?.sessionID).toBe("ses-auto-1")
    expect(turns[1]?.sessionID).toBe("ses-auto-1")
  })

  test("autonomous-run scenario rejects promoted-looking results that lack explicit completion evidence", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-run.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-run",
        timestamp: "2026-04-30T14-16-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1

          if (executionCount === 1) {
            await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
              JSON.stringify(
                {
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: ["smoke"],
                    failurePolicy: {
                      maxConsecutiveFailures: 3,
                      escalationAction: "pause_loop",
                      lastEscalationReason: null,
                    },
                  },
                  lastSessionID: "ses-auto-2",
                  latestLearning: {
                    summary: "The last autonomous iteration was promoted at revision rev-auto-2.",
                    remainingObjectives: [],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "pending",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                      },
                      lastCompletionEvidence: null,
                      attempts: 1,
                      consecutiveFailures: 0,
                      updatedAt: new Date(0).toISOString(),
                      lastSessionID: "ses-auto-2",
                      lastDecision: "promoted",
                      lastEscalationReason: null,
                    },
                  ],
                  iterations: [
                    {
                      decision: "promoted",
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      evaluations: [
                        {
                          scenarioName: "smoke",
                          exitCode: 0,
                        },
                      ],
                    },
                  ],
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
              JSON.stringify(
                {
                  skills: {},
                  agents: {},
                  commands: {},
                  memories: {},
                  quarantine: {},
                  currentRevision: "rev-auto-2",
                  pendingRevision: null,
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              '{"action":"promote","status":"success","revisionID":"rev-auto-2"}\n',
            )

            return {
              stdout: [
                buildToolEvent("evolver_autonomous_configure", "ses-auto-2", AUTONOMOUS_RUN_CONFIGURE_INPUT),
                buildToolEvent("evolver_autonomous_start", "ses-auto-2", {}),
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: [
              '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-auto-2"}',
              '{"type":"tool","tool":"evolver_status","sessionID":"ses-auto-2"}',
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/queued objective|completion evidence/i)
  })

  test("autonomous-run scenario rejects runs with the wrong configure payload", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-run.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-run",
        timestamp: "2026-04-30T14-16-30.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1

          if (executionCount === 1) {
            await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
            await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
            await writeFile(
              join(workspaceRoot, ".opencode/memory/autonomous-evidence-memory.md"),
              "---\nname: autonomous-evidence-memory\ndescription: Evidence fixture for autonomous eval coverage.\n---\n\n# Autonomous Evidence Memory\n",
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
              JSON.stringify(
                {
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: ["smoke"],
                    failurePolicy: {
                      maxConsecutiveFailures: 3,
                      escalationAction: "pause_loop",
                      lastEscalationReason: null,
                    },
                  },
                  lastSessionID: "ses-auto-2b",
                  latestLearning: {
                    summary: "The last autonomous iteration was promoted at revision rev-auto-2b.",
                    remainingObjectives: [],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "completed",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                      },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        checkedAt: new Date(0).toISOString(),
                      },
                      attempts: 1,
                      consecutiveFailures: 0,
                      updatedAt: new Date(0).toISOString(),
                      lastSessionID: "ses-auto-2b",
                      lastDecision: "promoted",
                      lastEscalationReason: null,
                    },
                  ],
                  iterations: [
                    {
                      decision: "promoted",
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      evaluations: [
                        { scenarioName: "smoke", exitCode: 0 },
                        { scenarioName: "objective-memory-evidence", exitCode: 0 },
                      ],
                    },
                  ],
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
              JSON.stringify(
                {
                  skills: {},
                  agents: {},
                  commands: {},
                  memories: {
                    "autonomous-evidence-memory": {
                      kind: "memory",
                      name: "autonomous-evidence-memory",
                      nativePath: ".opencode/memory/autonomous-evidence-memory.md",
                      revisionID: "rev-auto-2b",
                      contentHash: "ab".repeat(32),
                    },
                  },
                  quarantine: {},
                  currentRevision: "rev-auto-2b",
                  pendingRevision: null,
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              '{"action":"promote","status":"success","revisionID":"rev-auto-2b"}\n',
            )

            return {
              stdout: [
                buildToolEvent("evolver_autonomous_configure", "ses-auto-2b", {
                  ...AUTONOMOUS_RUN_CONFIGURE_INPUT,
                  verificationCommands: [["bun", "run", "typecheck"]],
                }),
                buildToolEvent("evolver_autonomous_start", "ses-auto-2b", {}),
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: [
              buildToolEvent("evolver_autonomous_status", "ses-auto-2b", {}),
              buildToolEvent("evolver_status", "ses-auto-2b", {}),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/configure payload/i)
  })

  test("autonomous-run scenario rejects runs that skip the required turn-2 status reads", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-run.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-run",
        timestamp: "2026-04-30T14-18-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1

          if (executionCount === 1) {
            await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
            await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
            await writeFile(
              join(workspaceRoot, ".opencode/memory/autonomous-evidence-memory.md"),
              "---\nname: autonomous-evidence-memory\ndescription: Evidence fixture for autonomous eval coverage.\n---\n\n# Autonomous Evidence Memory\n",
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
              JSON.stringify(
                {
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: ["smoke"],
                    failurePolicy: {
                      maxConsecutiveFailures: 3,
                      escalationAction: "pause_loop",
                      lastEscalationReason: null,
                    },
                  },
                  lastSessionID: "ses-auto-3",
                  latestLearning: {
                    summary: "The last autonomous iteration was promoted at revision rev-auto-3.",
                    remainingObjectives: [],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "completed",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                      },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        checkedAt: new Date(0).toISOString(),
                      },
                      attempts: 1,
                      consecutiveFailures: 0,
                      updatedAt: new Date(0).toISOString(),
                      lastSessionID: "ses-auto-3",
                      lastDecision: "promoted",
                      lastEscalationReason: null,
                    },
                  ],
                  iterations: [
                    {
                      decision: "promoted",
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      evaluations: [
                        { scenarioName: "smoke", exitCode: 0 },
                        { scenarioName: "objective-memory-evidence", exitCode: 0 },
                      ],
                    },
                  ],
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
              JSON.stringify(
                {
                  skills: {},
                  agents: {},
                  commands: {},
                  memories: {
                    "autonomous-evidence-memory": {
                      kind: "memory",
                      name: "autonomous-evidence-memory",
                      nativePath: ".opencode/memory/autonomous-evidence-memory.md",
                      revisionID: "rev-auto-3",
                      contentHash: "a".repeat(64),
                    },
                  },
                  quarantine: {},
                  currentRevision: "rev-auto-3",
                  pendingRevision: null,
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              '{"action":"promote","status":"success","revisionID":"rev-auto-3"}\n',
            )

            return {
              stdout: [
                buildToolEvent("evolver_autonomous_configure", "ses-auto-3", AUTONOMOUS_RUN_CONFIGURE_INPUT),
                buildToolEvent("evolver_autonomous_start", "ses-auto-3", {}),
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: '{"type":"text","text":"looks good","sessionID":"ses-auto-3"}',
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/turn-2 status/i)
  })

  test("autonomous-run scenario rejects runs that execute extra tools in turn 2", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-run.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-run",
        timestamp: "2026-04-30T14-20-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1

          if (executionCount === 1) {
            await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
            await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
            await writeFile(
              join(workspaceRoot, ".opencode/memory/autonomous-evidence-memory.md"),
              "---\nname: autonomous-evidence-memory\ndescription: Evidence fixture for autonomous eval coverage.\n---\n\n# Autonomous Evidence Memory\n",
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
              JSON.stringify(
                {
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: ["smoke"],
                    failurePolicy: {
                      maxConsecutiveFailures: 3,
                      escalationAction: "pause_loop",
                      lastEscalationReason: null,
                    },
                  },
                  lastSessionID: "ses-auto-4",
                  latestLearning: {
                    summary: "The last autonomous iteration was promoted at revision rev-auto-4.",
                    remainingObjectives: [],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "completed",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                      },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        checkedAt: new Date(0).toISOString(),
                      },
                      attempts: 1,
                      consecutiveFailures: 0,
                      updatedAt: new Date(0).toISOString(),
                      lastSessionID: "ses-auto-4",
                      lastDecision: "promoted",
                      lastEscalationReason: null,
                    },
                  ],
                  iterations: [
                    {
                      decision: "promoted",
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      evaluations: [
                        { scenarioName: "smoke", exitCode: 0 },
                        { scenarioName: "objective-memory-evidence", exitCode: 0 },
                      ],
                    },
                  ],
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
              JSON.stringify(
                {
                  skills: {},
                  agents: {},
                  commands: {},
                  memories: {
                    "autonomous-evidence-memory": {
                      kind: "memory",
                      name: "autonomous-evidence-memory",
                      nativePath: ".opencode/memory/autonomous-evidence-memory.md",
                      revisionID: "rev-auto-4",
                      contentHash: "b".repeat(64),
                    },
                  },
                  quarantine: {},
                  currentRevision: "rev-auto-4",
                  pendingRevision: null,
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              '{"action":"promote","status":"success","revisionID":"rev-auto-4"}\n',
            )

            return {
              stdout: [
                buildToolEvent("evolver_autonomous_configure", "ses-auto-4", AUTONOMOUS_RUN_CONFIGURE_INPUT),
                buildToolEvent("evolver_autonomous_start", "ses-auto-4", {}),
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: [
              '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-auto-4"}',
              '{"type":"tool","tool":"evolver_status","sessionID":"ses-auto-4"}',
              '{"type":"tool","tool":"evolver_write_memory","sessionID":"ses-auto-4"}',
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/turn-2 status-only path|mutating tool/i)
  })

  test("autonomous-run scenario rejects runs that add an unexpected third turn", async () => {
    const autonomousRunPrompt = await readFile(
      new URL("../../eval/scenarios/autonomous-run.md", import.meta.url),
      "utf8",
    )

    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      `${autonomousRunPrompt}\n\n---\n\nTurn 3:\n\nSay \"extra turn\".`,
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-run",
        timestamp: "2026-04-30T14-22-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1

          if (executionCount === 1) {
            await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
            await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
            await writeFile(
              join(workspaceRoot, ".opencode/memory/autonomous-evidence-memory.md"),
              "---\nname: autonomous-evidence-memory\ndescription: Evidence fixture for autonomous eval coverage.\n---\n\n# Autonomous Evidence Memory\n",
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
              JSON.stringify(
                {
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: ["smoke"],
                    failurePolicy: {
                      maxConsecutiveFailures: 3,
                      escalationAction: "pause_loop",
                      lastEscalationReason: null,
                    },
                  },
                  lastSessionID: "ses-auto-5",
                  latestLearning: {
                    summary: "The last autonomous iteration was promoted at revision rev-auto-5.",
                    remainingObjectives: [],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "completed",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                      },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        checkedAt: new Date(0).toISOString(),
                      },
                      attempts: 1,
                      consecutiveFailures: 0,
                      updatedAt: new Date(0).toISOString(),
                      lastSessionID: "ses-auto-5",
                      lastDecision: "promoted",
                      lastEscalationReason: null,
                    },
                  ],
                  iterations: [
                    {
                      decision: "promoted",
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      evaluations: [
                        { scenarioName: "smoke", exitCode: 0 },
                        { scenarioName: "objective-memory-evidence", exitCode: 0 },
                      ],
                    },
                  ],
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
              JSON.stringify(
                {
                  skills: {},
                  agents: {},
                  commands: {},
                  memories: {
                    "autonomous-evidence-memory": {
                      kind: "memory",
                      name: "autonomous-evidence-memory",
                      nativePath: ".opencode/memory/autonomous-evidence-memory.md",
                      revisionID: "rev-auto-5",
                      contentHash: "c".repeat(64),
                    },
                  },
                  quarantine: {},
                  currentRevision: "rev-auto-5",
                  pendingRevision: null,
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              '{"action":"promote","status":"success","revisionID":"rev-auto-5"}\n',
            )

            return {
              stdout: [
                buildToolEvent("evolver_autonomous_configure", "ses-auto-5", AUTONOMOUS_RUN_CONFIGURE_INPUT),
                buildToolEvent("evolver_autonomous_start", "ses-auto-5", {}),
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
            return {
              stdout: [
                '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-auto-5"}',
                '{"type":"tool","tool":"evolver_status","sessionID":"ses-auto-5"}',
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: '{"type":"text","text":"extra turn","sessionID":"ses-auto-5"}',
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/exactly 2 turns/i)
  })

  test("objective-memory-evidence scenario rejects runs that skip the required status reads", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/objective-memory-evidence.md"),
      await readFile(new URL("../../eval/scenarios/objective-memory-evidence.md", import.meta.url), "utf8"),
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "objective-memory-evidence",
        timestamp: "2026-04-30T14-17-00.000Z",
        executeCommand: async () => {
          return {
            stdout: '{"type":"text","text":"ok","sessionID":"ses-objective-1"}',
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/status-only|status.*read/i)
  })

  test("objective-memory-evidence scenario rejects runs that execute mutating tools", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/objective-memory-evidence.md"),
      await readFile(new URL("../../eval/scenarios/objective-memory-evidence.md", import.meta.url), "utf8"),
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "objective-memory-evidence",
        timestamp: "2026-04-30T14-19-00.000Z",
        executeCommand: async () => {
          return {
            stdout: [
              '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-objective-2"}',
              '{"type":"tool","tool":"evolver_status","sessionID":"ses-objective-2"}',
              '{"type":"tool","tool":"evolver_write_memory","sessionID":"ses-objective-2"}',
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/status-only|mutating tool/i)
  })

  test("objective-memory-evidence scenario rejects runs that execute non-evolver mutating tools", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/objective-memory-evidence.md"),
      await readFile(new URL("../../eval/scenarios/objective-memory-evidence.md", import.meta.url), "utf8"),
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "objective-memory-evidence",
        timestamp: "2026-04-30T14-21-00.000Z",
        executeCommand: async () => {
          return {
            stdout: [
              '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-objective-3"}',
              '{"type":"tool","tool":"evolver_status","sessionID":"ses-objective-3"}',
              '{"type":"tool","tool":"apply_patch","sessionID":"ses-objective-3"}',
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/status-only/i)
  })

  test("objective-memory-evidence scenario rejects runs that add an unexpected second turn", async () => {
    const objectivePrompt = await readFile(
      new URL("../../eval/scenarios/objective-memory-evidence.md", import.meta.url),
      "utf8",
    )

    await writeFile(
      join(repoRoot, "eval/scenarios/objective-memory-evidence.md"),
      `${objectivePrompt}\n\n---\n\nTurn 2:\n\nSay \"extra turn\".`,
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "objective-memory-evidence",
        timestamp: "2026-04-30T14-22-30.000Z",
        executeCommand: async () => {
          executionCount += 1

          if (executionCount === 1) {
            return {
              stdout: [
                '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-objective-4"}',
                '{"type":"tool","tool":"evolver_status","sessionID":"ses-objective-4"}',
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: '{"type":"text","text":"extra turn","sessionID":"ses-objective-4"}',
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/exactly 1 turn/i)
  })

  test("command-runtime scenario is part of the default sweep and captures memory-command session artifacts", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/command-runtime.md"),
      await readFile(new URL("../../eval/scenarios/command-runtime.md", import.meta.url), "utf8"),
    )

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "command-runtime",
      timestamp: "2026-04-30T14-30-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
        await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
        await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
        await writeFile(
          join(workspaceRoot, ".opencode/memory/session-routing.md"),
          [
            "---",
            "name: session-routing",
            "description: Session runtime guidance.",
            "storage_mode: memory-and-artifact",
            "---",
            "",
            "Prefer session-applied guidance.",
            "",
          ].join("\n"),
        )
        await writeFile(
          join(workspaceRoot, ".opencode/memory/command-routing.md"),
          [
            "---",
            "name: command-routing",
            "description: Command runtime guidance.",
            "storage_mode: memory-and-artifact",
            "---",
            "",
            "Prefer command-owned guidance.",
            "",
          ].join("\n"),
        )
        await writeFile(
          join(workspaceRoot, ".opencode/commands/review-markdown.md"),
          [
            "---",
            "description: Review markdown with command-owned runtime metadata",
            "model: openai/gpt-5.4",
            "memory:",
            "  - command-routing",
            "permission:",
            "  edit: deny",
            "---",
            "",
            "Review README.md for markdown issues.",
            "",
          ].join("\n"),
        )
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/sessions/session-command-runtime-green.json"),
          `${JSON.stringify(
            {
              memories: {
                "session-routing": {
                  storageMode: "memory-and-artifact",
                },
                "command-routing": {
                  storageMode: "memory-and-artifact",
                },
              },
              operatorGuideApplied: true,
              runtimePolicy: {
                sourceKind: "command",
                sourceName: "review-markdown",
                toolPermissions: {
                  edit: "deny",
                },
                preferredModel: "openai/gpt-5.4",
              },
            },
            null,
            2,
          )}\n`,
        )
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
          JSON.stringify(
            {
              skills: {},
              agents: {},
              commands: {
                "review-markdown": {
                  kind: "command",
                  name: "review-markdown",
                  nativePath: ".opencode/commands/review-markdown.md",
                  revisionID: "rev-command-runtime",
                  contentHash: "d".repeat(64),
                },
              },
              memories: {
                "session-routing": {
                  kind: "memory",
                  name: "session-routing",
                  nativePath: ".opencode/memory/session-routing.md",
                  revisionID: "rev-command-runtime",
                  contentHash: "c".repeat(64),
                },
                "command-routing": {
                  kind: "memory",
                  name: "command-routing",
                  nativePath: ".opencode/memory/command-routing.md",
                  revisionID: "rev-command-runtime",
                  contentHash: "e".repeat(64),
                },
              },
              quarantine: {},
              currentRevision: "rev-command-runtime",
              pendingRevision: null,
            },
            null,
            2,
          ),
        )
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
          [
            JSON.stringify({ action: "write_memory", status: "success" }),
            JSON.stringify({ action: "write_memory", status: "success" }),
            JSON.stringify({ action: "apply_memory", status: "success" }),
            JSON.stringify({ action: "write_command", status: "success" }),
            JSON.stringify({ action: "run_command", status: "success" }),
          ].join("\n") + "\n",
        )

        return {
          stdout: [
            buildToolEvent("evolver_write_memory", "session-command-runtime-green", {
              memoryName: "session-routing",
            }),
            buildToolEvent("evolver_write_memory", "session-command-runtime-green", {
              memoryName: "command-routing",
            }),
            buildToolEvent("evolver_apply_memory", "session-command-runtime-green", {
              memoryName: "session-routing",
            }),
            buildToolEvent("evolver_write_command", "session-command-runtime-green", {
              commandName: "review-markdown",
            }),
            buildToolEvent("evolver_run_command", "session-command-runtime-green", {
              commandName: "review-markdown",
              prompt: "Review README.md.",
            }),
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
    }

    expect(DEFAULT_SCENARIOS).toContain("command-runtime")
    expect(resultJson.changedFiles).toContain(".opencode/memory/session-routing.md")
    expect(resultJson.changedFiles).toContain(".opencode/memory/command-routing.md")
    expect(resultJson.changedFiles).toContain(".opencode/commands/review-markdown.md")
    expect(resultJson.changedFiles).toContain(
      ".opencode/oc-evolver/sessions/session-command-runtime-green.json",
    )
  })

  test("command-runtime scenario rejects runs that apply the wrong memory profile", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/command-runtime.md"),
      await readFile(new URL("../../eval/scenarios/command-runtime.md", import.meta.url), "utf8"),
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "command-runtime",
        timestamp: "2026-04-30T14-30-30.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/memory/session-routing.md"),
            ["---", "name: session-routing", "description: Session runtime guidance.", "storage_mode: memory-and-artifact", "---", "", "Prefer session-applied guidance.", ""].join("\n"),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/memory/command-routing.md"),
            ["---", "name: command-routing", "description: Command runtime guidance.", "storage_mode: memory-and-artifact", "---", "", "Prefer command-owned guidance.", ""].join("\n"),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/commands/review-markdown.md"),
            ["---", "description: Review markdown with command-owned runtime metadata", "model: openai/gpt-5.4", "memory:", "  - command-routing", "permission:", "  edit: deny", "---", "", "Review README.md for markdown issues.", ""].join("\n"),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/sessions/session-command-runtime-bad-memory.json"),
            `${JSON.stringify({ memories: { "session-routing": { storageMode: "memory-and-artifact" }, "command-routing": { storageMode: "memory-and-artifact" } }, operatorGuideApplied: true, runtimePolicy: { sourceKind: "command", sourceName: "review-markdown", toolPermissions: { edit: "deny" }, preferredModel: "openai/gpt-5.4" } }, null, 2)}\n`,
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify({ skills: {}, agents: {}, commands: { "review-markdown": { kind: "command", name: "review-markdown", nativePath: ".opencode/commands/review-markdown.md", revisionID: "rev-command-runtime", contentHash: "d".repeat(64) } }, memories: { "session-routing": { kind: "memory", name: "session-routing", nativePath: ".opencode/memory/session-routing.md", revisionID: "rev-command-runtime", contentHash: "c".repeat(64) }, "command-routing": { kind: "memory", name: "command-routing", nativePath: ".opencode/memory/command-routing.md", revisionID: "rev-command-runtime", contentHash: "e".repeat(64) } }, quarantine: {}, currentRevision: "rev-command-runtime", pendingRevision: null }, null, 2),
          )
          await writeFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), [JSON.stringify({ action: "write_memory", status: "success" }), JSON.stringify({ action: "write_memory", status: "success" }), JSON.stringify({ action: "apply_memory", status: "success" }), JSON.stringify({ action: "write_command", status: "success" }), JSON.stringify({ action: "run_command", status: "success" })].join("\n") + "\n")

          return {
            stdout: [
              buildToolEvent("evolver_write_memory", "session-command-runtime-bad-memory", { memoryName: "session-routing" }),
              buildToolEvent("evolver_write_memory", "session-command-runtime-bad-memory", { memoryName: "command-routing" }),
              buildToolEvent("evolver_apply_memory", "session-command-runtime-bad-memory", { memoryName: "command-routing" }),
              buildToolEvent("evolver_write_command", "session-command-runtime-bad-memory", { commandName: "review-markdown" }),
              buildToolEvent("evolver_run_command", "session-command-runtime-bad-memory", { commandName: "review-markdown", prompt: "Review README.md." }),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/session-routing|apply only the required session-routing memory/i)
  })

  test("command-runtime scenario rejects runs that do not write session-routing then command-routing", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/command-runtime.md"),
      await readFile(new URL("../../eval/scenarios/command-runtime.md", import.meta.url), "utf8"),
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "command-runtime",
        timestamp: "2026-04-30T14-30-45.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await writeFile(join(workspaceRoot, ".opencode/memory/session-routing.md"), ["---", "name: session-routing", "description: Session runtime guidance.", "storage_mode: memory-and-artifact", "---", "", "Prefer session-applied guidance.", ""].join("\n"))
          await writeFile(join(workspaceRoot, ".opencode/memory/command-routing.md"), ["---", "name: command-routing", "description: Command runtime guidance.", "storage_mode: memory-and-artifact", "---", "", "Prefer command-owned guidance.", ""].join("\n"))
          await writeFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), ["---", "description: Review markdown with command-owned runtime metadata", "model: openai/gpt-5.4", "memory:", "  - command-routing", "permission:", "  edit: deny", "---", "", "Review README.md for markdown issues.", ""].join("\n"))
          await writeFile(join(workspaceRoot, ".opencode/oc-evolver/sessions/session-command-runtime-bad-order.json"), `${JSON.stringify({ memories: { "session-routing": { storageMode: "memory-and-artifact" }, "command-routing": { storageMode: "memory-and-artifact" } }, operatorGuideApplied: true, runtimePolicy: { sourceKind: "command", sourceName: "review-markdown", toolPermissions: { edit: "deny" }, preferredModel: "openai/gpt-5.4" } }, null, 2)}\n`)
          await writeFile(join(workspaceRoot, ".opencode/oc-evolver/registry.json"), JSON.stringify({ skills: {}, agents: {}, commands: { "review-markdown": { kind: "command", name: "review-markdown", nativePath: ".opencode/commands/review-markdown.md", revisionID: "rev-command-runtime", contentHash: "d".repeat(64) } }, memories: { "session-routing": { kind: "memory", name: "session-routing", nativePath: ".opencode/memory/session-routing.md", revisionID: "rev-command-runtime", contentHash: "c".repeat(64) }, "command-routing": { kind: "memory", name: "command-routing", nativePath: ".opencode/memory/command-routing.md", revisionID: "rev-command-runtime", contentHash: "e".repeat(64) } }, quarantine: {}, currentRevision: "rev-command-runtime", pendingRevision: null }, null, 2))
          await writeFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), [JSON.stringify({ action: "write_memory", status: "success" }), JSON.stringify({ action: "write_memory", status: "success" }), JSON.stringify({ action: "apply_memory", status: "success" }), JSON.stringify({ action: "write_command", status: "success" }), JSON.stringify({ action: "run_command", status: "success" })].join("\n") + "\n")

          return {
            stdout: [
              buildToolEvent("evolver_write_memory", "session-command-runtime-bad-order", { memoryName: "command-routing" }),
              buildToolEvent("evolver_write_memory", "session-command-runtime-bad-order", { memoryName: "session-routing" }),
              buildToolEvent("evolver_apply_memory", "session-command-runtime-bad-order", { memoryName: "session-routing" }),
              buildToolEvent("evolver_write_command", "session-command-runtime-bad-order", { commandName: "review-markdown" }),
              buildToolEvent("evolver_run_command", "session-command-runtime-bad-order", { commandName: "review-markdown", prompt: "Review README.md." }),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/write session-routing then command-routing/i)
  })

  test("command-runtime scenario rejects runs that omit command-owned metadata from the durable command artifact", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/command-runtime.md"),
      await readFile(new URL("../../eval/scenarios/command-runtime.md", import.meta.url), "utf8"),
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "command-runtime",
        timestamp: "2026-04-30T14-31-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await writeFile(join(workspaceRoot, ".opencode/memory/session-routing.md"), ["---", "name: session-routing", "description: Session runtime guidance.", "storage_mode: memory-and-artifact", "---", "", "Prefer session-applied guidance.", ""].join("\n"))
          await writeFile(join(workspaceRoot, ".opencode/memory/command-routing.md"), ["---", "name: command-routing", "description: Command runtime guidance.", "storage_mode: memory-and-artifact", "---", "", "Prefer command-owned guidance.", ""].join("\n"))
          await writeFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), ["---", "description: Review markdown with missing metadata", "---", "", "Review README.md for markdown issues.", ""].join("\n"))
          await writeFile(join(workspaceRoot, ".opencode/oc-evolver/sessions/session-command-runtime-bad-doc.json"), `${JSON.stringify({ memories: { "session-routing": { storageMode: "memory-and-artifact" }, "command-routing": { storageMode: "memory-and-artifact" } }, operatorGuideApplied: true, runtimePolicy: { sourceKind: "command", sourceName: "review-markdown", toolPermissions: { edit: "deny" }, preferredModel: "openai/gpt-5.4" } }, null, 2)}\n`)
          await writeFile(join(workspaceRoot, ".opencode/oc-evolver/registry.json"), JSON.stringify({ skills: {}, agents: {}, commands: { "review-markdown": { kind: "command", name: "review-markdown", nativePath: ".opencode/commands/review-markdown.md", revisionID: "rev-command-runtime", contentHash: "d".repeat(64) } }, memories: { "session-routing": { kind: "memory", name: "session-routing", nativePath: ".opencode/memory/session-routing.md", revisionID: "rev-command-runtime", contentHash: "c".repeat(64) }, "command-routing": { kind: "memory", name: "command-routing", nativePath: ".opencode/memory/command-routing.md", revisionID: "rev-command-runtime", contentHash: "e".repeat(64) } }, quarantine: {}, currentRevision: "rev-command-runtime", pendingRevision: null }, null, 2))
          await writeFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), [JSON.stringify({ action: "write_memory", status: "success" }), JSON.stringify({ action: "write_memory", status: "success" }), JSON.stringify({ action: "apply_memory", status: "success" }), JSON.stringify({ action: "write_command", status: "success" }), JSON.stringify({ action: "run_command", status: "success" })].join("\n") + "\n")

          return {
            stdout: [
              buildToolEvent("evolver_write_memory", "session-command-runtime-bad-doc", { memoryName: "session-routing" }),
              buildToolEvent("evolver_write_memory", "session-command-runtime-bad-doc", { memoryName: "command-routing" }),
              buildToolEvent("evolver_apply_memory", "session-command-runtime-bad-doc", { memoryName: "session-routing" }),
              buildToolEvent("evolver_write_command", "session-command-runtime-bad-doc", { commandName: "review-markdown" }),
              buildToolEvent("evolver_run_command", "session-command-runtime-bad-doc", { commandName: "review-markdown", prompt: "Review README.md." }),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/command document is missing required command-owned metadata|command-owned metadata/i)
  })

  test("revision-lifecycle scenario is part of the default sweep and captures pending-review deletion flow", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/revision-lifecycle.md"),
      await readFile(new URL("../../eval/scenarios/revision-lifecycle.md", import.meta.url), "utf8"),
    )

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "revision-lifecycle",
      timestamp: "2026-04-30T14-31-00.000Z",
      executeCommand: async ({ workspaceRoot, prompt }) => {
        await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
        await mkdir(join(workspaceRoot, ".opencode/oc-evolver/revisions"), { recursive: true })

        if (prompt.includes("Turn 1")) {
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/pending-review.json"),
            JSON.stringify(
              {
                currentRevisionID: "rev-first",
                pendingRevisionID: "rev-delete",
                changedArtifacts: {
                  skills: [],
                  agents: [],
                  commands: ["review-markdown"],
                  memories: [],
                },
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/pending-review-snapshot.json"),
            JSON.stringify(
              {
                pendingRevisionID: "rev-delete",
                snapshotPath: ".opencode/oc-evolver/revisions/rev-delete.json",
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/pending-deletion-state.json"),
            JSON.stringify({ commandPresent: false }, null, 2),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify(
              {
                skills: {},
                agents: {},
                commands: {},
                memories: {},
                quarantine: {},
                currentRevision: "rev-first",
                pendingRevision: "rev-delete",
              },
              null,
              2,
            ),
          )
          await writeFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), "")
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/revisions/rev-first.json"),
            JSON.stringify({ revisionID: "rev-first" }, null, 2),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/revisions/rev-delete.json"),
            JSON.stringify({ revisionID: "rev-delete" }, null, 2),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }),
              JSON.stringify({ action: "promote", status: "success", revisionID: "rev-first" }),
              JSON.stringify({ action: "delete_artifact", status: "success", revisionID: "rev-delete", target: "command:review-markdown" }),
              JSON.stringify({ action: "review_pending", status: "success", target: ".opencode/oc-evolver/pending-review.json" }),
            ].join("\n") + "\n",
          )

          return {
            stdout: [
              buildToolEvent("evolver_write_command", "ses-revision-lifecycle", { commandName: "review-markdown" }),
              buildToolEvent("evolver_promote", "ses-revision-lifecycle", {}),
              buildToolEvent("evolver_delete_artifact", "ses-revision-lifecycle", { kind: "command", name: "review-markdown" }),
              buildToolEvent(
                "evolver_review_pending",
                "ses-revision-lifecycle",
                {},
                JSON.stringify({
                  currentRevisionID: "rev-first",
                  pendingRevisionID: "rev-delete",
                  changedArtifacts: {
                    skills: [],
                    agents: [],
                    commands: ["review-markdown"],
                    memories: [],
                  },
                }),
              ),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        await writeFile(
          join(workspaceRoot, ".opencode/commands/review-markdown.md"),
          ["---", "description: First review flow", "---", "", "Review README.md once.", ""].join("\n"),
        )
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
          JSON.stringify(
            {
              skills: {},
              agents: {},
              commands: {
                "review-markdown": {
                  kind: "command",
                  name: "review-markdown",
                  nativePath: ".opencode/commands/review-markdown.md",
                  revisionID: "rev-first",
                  contentHash: "f".repeat(64),
                },
              },
              memories: {},
              quarantine: {},
              currentRevision: "rev-first",
              pendingRevision: null,
            },
            null,
            2,
          ),
        )
        await rm(join(workspaceRoot, ".opencode/oc-evolver/revisions/rev-delete.json"), { force: true })
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
          [
          JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }),
          JSON.stringify({ action: "promote", status: "success", revisionID: "rev-first" }),
          JSON.stringify({ action: "delete_artifact", status: "success", revisionID: "rev-delete", target: "command:review-markdown" }),
          JSON.stringify({ action: "review_pending", status: "success", target: ".opencode/oc-evolver/pending-review.json" }),
          JSON.stringify({ action: "reject", status: "success", revisionID: "rev-first", rejectedRevisionID: "rev-delete" }),
          JSON.stringify({ action: "prune", status: "success", target: ".opencode/oc-evolver/revisions", detail: "pruned 1 obsolete revisions" }),
        ].join("\n") + "\n",
        )

        return {
          stdout: [
            buildToolEvent("evolver_reject", "ses-revision-lifecycle", {}),
            buildToolEvent("evolver_prune", "ses-revision-lifecycle", {}),
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
    }

    expect(DEFAULT_SCENARIOS).toContain("revision-lifecycle")
    expect(resultJson.changedFiles).toContain(".opencode/commands/review-markdown.md")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/registry.json")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/audit.ndjson")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/pending-review.json")
  })

  test("revision-lifecycle scenario rejects runs that leave an obsolete revision snapshot behind", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/revision-lifecycle.md"),
      await readFile(new URL("../../eval/scenarios/revision-lifecycle.md", import.meta.url), "utf8"),
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "revision-lifecycle",
        timestamp: "2026-04-30T14-31-30.000Z",
        executeCommand: async ({ workspaceRoot, prompt }) => {
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/revisions"), { recursive: true })

          if (prompt.includes("Turn 1")) {
            await writeFile(join(workspaceRoot, ".opencode/oc-evolver/revisions/rev-first.json"), JSON.stringify({ revisionID: "rev-first" }, null, 2))
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/pending-review.json"),
              JSON.stringify(
                {
                  currentRevisionID: "rev-first",
                  pendingRevisionID: "rev-delete",
                  changedArtifacts: { skills: [], agents: [], commands: ["review-markdown"], memories: [] },
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/pending-review-snapshot.json"),
              JSON.stringify(
                {
                  pendingRevisionID: "rev-delete",
                  snapshotPath: ".opencode/oc-evolver/revisions/rev-delete.json",
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/pending-deletion-state.json"),
              JSON.stringify({ commandPresent: false }, null, 2),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
              JSON.stringify({ skills: {}, agents: {}, commands: {}, memories: {}, quarantine: {}, currentRevision: "rev-first", pendingRevision: "rev-delete" }, null, 2),
            )
            await writeFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), "")
            await writeFile(join(workspaceRoot, ".opencode/oc-evolver/revisions/rev-delete.json"), JSON.stringify({ revisionID: "rev-delete" }, null, 2))
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              [
                JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }),
                JSON.stringify({ action: "promote", status: "success", revisionID: "rev-first" }),
                JSON.stringify({ action: "delete_artifact", status: "success", revisionID: "rev-delete", target: "command:review-markdown" }),
                JSON.stringify({ action: "review_pending", status: "success", target: ".opencode/oc-evolver/pending-review.json" }),
              ].join("\n") + "\n",
            )

            return {
              stdout: [
                buildToolEvent("evolver_write_command", "ses-revision-lifecycle-bad", { commandName: "review-markdown" }),
                buildToolEvent("evolver_promote", "ses-revision-lifecycle-bad", {}),
                buildToolEvent("evolver_delete_artifact", "ses-revision-lifecycle-bad", { kind: "command", name: "review-markdown" }),
                buildToolEvent(
                  "evolver_review_pending",
                  "ses-revision-lifecycle-bad",
                  {},
                  JSON.stringify({
                    currentRevisionID: "rev-first",
                    pendingRevisionID: "rev-delete",
                    changedArtifacts: { skills: [], agents: [], commands: ["review-markdown"], memories: [] },
                  }),
                ),
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          await writeFile(
            join(workspaceRoot, ".opencode/commands/review-markdown.md"),
            ["---", "description: First review flow", "---", "", "Review README.md once.", ""].join("\n"),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
            JSON.stringify(
              {
                skills: {},
                agents: {},
                commands: {
                  "review-markdown": {
                    kind: "command",
                    name: "review-markdown",
                    nativePath: ".opencode/commands/review-markdown.md",
                    revisionID: "rev-first",
                    contentHash: "f".repeat(64),
                  },
                },
                memories: {},
                quarantine: {},
                currentRevision: "rev-first",
                pendingRevision: null,
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }),
              JSON.stringify({ action: "promote", status: "success", revisionID: "rev-first" }),
              JSON.stringify({ action: "delete_artifact", status: "success", revisionID: "rev-delete", target: "command:review-markdown" }),
              JSON.stringify({ action: "review_pending", status: "success", target: ".opencode/oc-evolver/pending-review.json" }),
              JSON.stringify({ action: "reject", status: "success", revisionID: "rev-first", rejectedRevisionID: "rev-delete" }),
              JSON.stringify({ action: "prune", status: "success", target: ".opencode/oc-evolver/revisions", detail: "pruned 1 obsolete revisions" }),
            ].join("\n") + "\n",
          )

          return {
            stdout: [
              buildToolEvent("evolver_reject", "ses-revision-lifecycle-bad", {}),
              buildToolEvent("evolver_prune", "ses-revision-lifecycle-bad", {}),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/prune|obsolete revision/i)
  })

  test("autonomous-control scenario is part of the default sweep and captures pause-resume control state", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-control.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-control.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "autonomous-control",
      timestamp: "2026-04-30T14-32-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        executionCount += 1

        if (executionCount === 1) {
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop-paused.json"),
            JSON.stringify(
              {
                config: {
                  enabled: true,
                  paused: true,
                  intervalMs: 60_000,
                },
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
            JSON.stringify(
              {
                config: {
                  enabled: true,
                  paused: true,
                  intervalMs: 60_000,
                  verificationCommands: [["bun", "run", "typecheck"]],
                  evaluationScenarios: ["autonomous-run"],
                  failurePolicy: {
                    maxConsecutiveFailures: 3,
                    escalationAction: "pause_loop",
                    lastEscalationReason: null,
                  },
                },
                lastSessionID: null,
                latestLearning: null,
                objectives: [],
                iterations: [],
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            JSON.stringify({ action: "autonomous_pause", status: "success", target: ".opencode/oc-evolver/autonomous-loop.json" }) + "\n",
          )

          return {
            stdout: [
              buildToolEvent("evolver_autonomous_configure", "ses-autonomous-control", {
                enabled: true,
                paused: false,
                intervalMs: 60_000,
                verificationCommands: [["bun", "run", "typecheck"]],
                evaluationScenarios: ["autonomous-run"],
                failurePolicy: {
                  maxConsecutiveFailures: 3,
                  escalationAction: "pause_loop",
                },
                objectives: [],
                replaceObjectives: true,
              }),
              buildToolEvent(
                "evolver_autonomous_pause",
                "ses-autonomous-control",
                {},
                JSON.stringify({
                  config: {
                    enabled: true,
                    paused: true,
                    intervalMs: 60_000,
                  },
                }),
              ),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
          JSON.stringify(
            {
              config: {
                enabled: true,
                paused: false,
                intervalMs: 60_000,
                verificationCommands: [["bun", "run", "typecheck"]],
                evaluationScenarios: ["autonomous-run"],
                failurePolicy: {
                  maxConsecutiveFailures: 3,
                  escalationAction: "pause_loop",
                  lastEscalationReason: null,
                },
              },
              lastSessionID: null,
              latestLearning: null,
              objectives: [],
              iterations: [],
            },
            null,
            2,
          ),
        )
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
          [
            JSON.stringify({ action: "autonomous_pause", status: "success", target: ".opencode/oc-evolver/autonomous-loop.json" }),
            JSON.stringify({ action: "autonomous_resume", status: "success", target: ".opencode/oc-evolver/autonomous-loop.json" }),
          ].join("\n") + "\n",
        )

        return {
          stdout: [
            buildToolEvent(
              "evolver_autonomous_resume",
              "ses-autonomous-control",
              {},
              JSON.stringify({
                config: {
                  enabled: true,
                  paused: false,
                  intervalMs: 60_000,
                },
                activation: {
                  mode: "worker",
                },
              }),
            ),
            buildToolEvent(
              "evolver_autonomous_status",
              "ses-autonomous-control",
              {},
              JSON.stringify({
                config: {
                  enabled: true,
                  paused: false,
                  intervalMs: 60_000,
                  verificationCommands: [["bun", "run", "typecheck"]],
                  evaluationScenarios: ["autonomous-run"],
                },
              }),
            ),
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }

    expect(DEFAULT_SCENARIOS).toContain("autonomous-control")
    expect(resultJson.turnCount).toBe(2)
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/autonomous-loop.json")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/autonomous-loop-paused.json")
  })

  test("autonomous-control scenario rejects runs that skip durable paused-state evidence", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-control.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-control.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-control",
        timestamp: "2026-04-30T14-32-30.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })

          if (executionCount === 1) {
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
              JSON.stringify(
                {
                  config: {
                    enabled: true,
                    paused: true,
                    intervalMs: 60_000,
                    verificationCommands: [["bun", "run", "typecheck"]],
                    evaluationScenarios: ["autonomous-run"],
                    failurePolicy: {
                      maxConsecutiveFailures: 3,
                      escalationAction: "pause_loop",
                      lastEscalationReason: null,
                    },
                  },
                  lastSessionID: null,
                  latestLearning: null,
                  objectives: [],
                  iterations: [],
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              JSON.stringify({ action: "autonomous_pause", status: "success", target: ".opencode/oc-evolver/autonomous-loop.json" }) + "\n",
            )

            return {
              stdout: [
                buildToolEvent("evolver_autonomous_configure", "ses-autonomous-control-bad", {
                  enabled: true,
                  paused: false,
                  intervalMs: 60_000,
                  verificationCommands: [["bun", "run", "typecheck"]],
                  evaluationScenarios: ["autonomous-run"],
                  failurePolicy: {
                    maxConsecutiveFailures: 3,
                    escalationAction: "pause_loop",
                  },
                  objectives: [],
                  replaceObjectives: true,
                }),
                buildToolEvent(
                  "evolver_autonomous_pause",
                  "ses-autonomous-control-bad",
                  {},
                  JSON.stringify({
                    config: {
                      enabled: true,
                      paused: false,
                      intervalMs: 60_000,
                    },
                  }),
                ),
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"),
            JSON.stringify(
              {
                config: {
                  enabled: true,
                  paused: false,
                  intervalMs: 60_000,
                  verificationCommands: [["bun", "run", "typecheck"]],
                  evaluationScenarios: ["autonomous-run"],
                  failurePolicy: {
                    maxConsecutiveFailures: 3,
                    escalationAction: "pause_loop",
                    lastEscalationReason: null,
                  },
                },
                lastSessionID: null,
                latestLearning: null,
                objectives: [],
                iterations: [],
              },
              null,
              2,
            ),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              JSON.stringify({ action: "autonomous_pause", status: "success", target: ".opencode/oc-evolver/autonomous-loop.json" }),
              JSON.stringify({ action: "autonomous_resume", status: "success", target: ".opencode/oc-evolver/autonomous-loop.json" }),
            ].join("\n") + "\n",
          )

          return {
            stdout: [
              buildToolEvent(
                "evolver_autonomous_resume",
                "ses-autonomous-control-bad",
                {},
                JSON.stringify({
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 60_000,
                  },
                  activation: {
                    mode: "worker",
                  },
                }),
              ),
              buildToolEvent(
                "evolver_autonomous_status",
                "ses-autonomous-control-bad",
                {},
                JSON.stringify({
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 60_000,
                    verificationCommands: [["bun", "run", "typecheck"]],
                    evaluationScenarios: ["autonomous-run"],
                  },
                }),
              ),
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/paused-state evidence|paused/i)
  })
})
