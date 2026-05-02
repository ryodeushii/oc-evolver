import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import * as evalHarness from "../../scripts/run-eval.ts"
import {
  DEFAULT_SCENARIOS,
  runEvaluationScenario,
  type EvalCommandResult,
} from "../../scripts/run-eval.ts"
import { createOCEvolverPlugin } from "../../src/oc-evolver.ts"
import { activateAutonomousLoop } from "../../src/kernel/autonomous-loop.ts"

const AUTONOMOUS_RUN_OBJECTIVE_PROMPT = `Make exactly one mutation by calling evolver_write_memory with memoryName "autonomous-evidence-memory" and document "---
name: autonomous-evidence-memory
description: Autonomous evaluation evidence memory.
---

Autonomous evaluation evidence memory.". After the write succeeds, respond with exactly one short confirmation sentence. Do not call evolver_autonomous_run. Do not call status tools before the write.`
const AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND = ["bun", "--version"]
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
      priority: 0,
      completionCriteria: {
        changedArtifacts: ["memory:autonomous-evidence-memory"],
        evaluationScenarios: ["objective-memory-evidence"],
        verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
      },
    },
  ],
  replaceObjectives: true,
  enabled: true,
  paused: false,
} as const
const AUTONOMOUS_PREVIEW_OBJECTIVE_PROMPT =
  "Repair the autonomous review command while keeping typecheck green."

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

  test("evaluation tiers keep the stable autonomous control-plane in regular runs", () => {
    expect(evalHarness.CORE_SCENARIOS).toEqual([
      "smoke",
      "policy-deny",
      "autonomous-run",
      "autonomous-control",
      "autonomous-startup",
    ])
    expect(evalHarness.PR_SCENARIOS).toEqual([
      ...evalHarness.CORE_SCENARIOS,
      "autonomous-preview",
      "autonomous-metrics",
      "autonomous-stop",
    ])
    expect(evalHarness.PR_SCENARIOS).not.toContain("objective-memory-evidence")
    expect(evalHarness.FULL_SCENARIOS).toEqual(
      expect.arrayContaining([
        ...evalHarness.PR_SCENARIOS,
        "objective-memory-evidence",
      ]),
    )
    expect(evalHarness.FULL_SCENARIOS).not.toContain("command-runtime")
    expect(evalHarness.FULL_SCENARIOS).not.toContain("reuse-skill")
    expect(evalHarness.FULL_SCENARIOS).not.toContain("revision-lifecycle")
  })

  test("autonomous-run uses a fixture-safe objective verification command", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-run.md", import.meta.url), "utf8"),
    )

    const scenarioDocument = await readFile(join(repoRoot, "eval/scenarios/autonomous-run.md"), "utf8")
    const configuredPrompt = AUTONOMOUS_RUN_CONFIGURE_INPUT.objectives[0]?.prompt ?? ""

    expect(AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND).toEqual(["bun", "--version"])
    expect(scenarioDocument).toContain('["bun", "--version"]')
    expect(scenarioDocument).toContain("Exit successfully after the autonomous status read completes.")
    expect(configuredPrompt).toContain('---\nname: autonomous-evidence-memory\ndescription: Autonomous evaluation evidence memory.\n---\n\nAutonomous evaluation evidence memory.')
    expect(configuredPrompt).not.toContain("\\n")
  })

  test("command-runtime docs state that successful command runs persist merged session memory state", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/command-runtime.md"),
      await readFile(new URL("../../eval/scenarios/command-runtime.md", import.meta.url), "utf8"),
    )
    await writeFile(
      join(repoRoot, "README.md"),
      await readFile(new URL("../../README.md", import.meta.url), "utf8"),
    )

    const scenarioDocument = await readFile(join(repoRoot, "eval/scenarios/command-runtime.md"), "utf8")
    const readmeDocument = await readFile(join(repoRoot, "README.md"), "utf8")

    expect(scenarioDocument).toContain("Turn 1:")
    expect(scenarioDocument).not.toContain("Turn 2:")
    expect(scenarioDocument).not.toContain("Turn 3:")
    expect(scenarioDocument).toContain("The harness already seeds an accepted `review-markdown` command")
    expect(scenarioDocument).toContain("Use `evolver_run_command` directly")
    expect(scenarioDocument).toContain("Run `review-markdown` once against `README.md`.")
    expect(scenarioDocument).toContain("Stop after the command finishes.")
    expect(scenarioDocument).toContain("successful command run leaves the continued session retaining the command-owned runtime policy")
    expect(readmeDocument).toContain("after a successful command run")
    expect(readmeDocument).toContain("persisting the resulting runtime policy and merged command memory state for the continued session")
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
                      verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                    },
                    lastCompletionEvidence: {
                      satisfied: true,
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                      passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      missingChangedArtifacts: [],
                      missingEvaluationScenarios: [],
                      missingVerificationCommands: [],
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
                    verification: [
                      {
                        command: AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND,
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
              stdout: buildToolEvent("evolver_autonomous_start", "ses-auto-1", {}),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
            expect(prompt).toContain("Turn 2")

            return {
              stdout: buildToolEvent(
                "evolver_autonomous_status",
              "ses-auto-1",
              {},
              JSON.stringify({
                config: {
                  enabled: true,
                  paused: false,
                  intervalMs: 0,
                  verificationCommands: [],
                  evaluationScenarios: ["smoke"],
                },
                objectives: [
                  {
                    prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                    status: "completed",
                    completionCriteria: {
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      evaluationScenarios: ["objective-memory-evidence"],
                      verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                    },
                    lastCompletionEvidence: {
                      satisfied: true,
                      changedArtifacts: ["memory:autonomous-evidence-memory"],
                      passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                      passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      missingChangedArtifacts: [],
                      missingEvaluationScenarios: [],
                      missingVerificationCommands: [],
                    },
                  },
                ],
              }),
            ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        expect(prompt).toContain("Turn 3")

        return {
          stdout: buildToolEvent(
            "evolver_status",
            "ses-auto-1",
            {},
            JSON.stringify({
              skills: {},
              agents: {},
              commands: {},
              memories: {
                "autonomous-evidence-memory": {
                  kind: "memory",
                  name: "autonomous-evidence-memory",
                  nativePath: ".opencode/memory/autonomous-evidence-memory.md",
                  revisionID: "rev-auto-1",
                  contentHash: "ab".repeat(32),
                },
              },
              quarantine: {},
              currentRevision: "rev-auto-1",
              pendingRevision: null,
            }),
          ),
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
    expect(resultJson.turnCount).toBe(3)
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/autonomous-loop.json")
    expect(resultJson.changedFiles).toContain(".opencode/memory/autonomous-evidence-memory.md")
    expect(turns).toHaveLength(3)
    expect(turns[0]?.sessionID).toBe("ses-auto-1")
    expect(turns[1]?.sessionID).toBe("ses-auto-1")
    expect(turns[2]?.sessionID).toBe("ses-auto-1")
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
                      verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
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
              stdout: buildToolEvent("evolver_autonomous_start", "ses-auto-2", {}),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
            return {
              stdout: buildToolEvent(
                "evolver_autonomous_status",
                "ses-auto-2",
                {},
                JSON.stringify({
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: ["smoke"],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "pending",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                        verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      },
                      lastCompletionEvidence: null,
                    },
                  ],
                }),
              ),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: buildToolEvent(
              "evolver_status",
              "ses-auto-2",
              {},
              JSON.stringify({
                skills: {},
                agents: {},
                commands: {},
                memories: {},
                quarantine: {},
                currentRevision: "rev-auto-2",
                pendingRevision: null,
              }),
            ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/queued objective|completion evidence|status output did not reflect/i)
  })

  test("autonomous-run scenario rejects stale status output even when persisted state looks promoted", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-run.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-run",
        timestamp: "2026-04-30T14-16-15.000Z",
        executeCommand: async ({ workspaceRoot }) => {
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
                  lastSessionID: "ses-auto-stale",
                  latestLearning: {
                    summary: "The last autonomous iteration was promoted at revision rev-auto-stale.",
                    remainingObjectives: [],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "completed",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                        verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        missingVerificationCommands: [],
                        checkedAt: new Date(0).toISOString(),
                      },
                      attempts: 1,
                      consecutiveFailures: 0,
                      updatedAt: new Date(0).toISOString(),
                      lastSessionID: "ses-auto-stale",
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
                      verification: [
                        {
                          command: AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND,
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
                      revisionID: "rev-auto-stale",
                      contentHash: "d".repeat(64),
                    },
                  },
                  quarantine: {},
                  currentRevision: "rev-auto-stale",
                  pendingRevision: null,
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              '{"action":"promote","status":"success","revisionID":"rev-auto-stale"}\n',
            )

            return {
              stdout: buildToolEvent("evolver_autonomous_start", "ses-auto-stale", {}),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
            return {
              stdout: buildToolEvent(
                "evolver_autonomous_status",
                "ses-auto-stale",
                {},
                JSON.stringify({
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: ["smoke"],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "pending",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                        verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      },
                      lastCompletionEvidence: null,
                    },
                  ],
                }),
              ),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: buildToolEvent(
              "evolver_status",
              "ses-auto-stale",
              {},
              JSON.stringify({
                skills: {},
                agents: {},
                commands: {},
                memories: {
                  "autonomous-evidence-memory": {
                    kind: "memory",
                    name: "autonomous-evidence-memory",
                    nativePath: ".opencode/memory/autonomous-evidence-memory.md",
                    revisionID: "rev-auto-stale",
                    contentHash: "ab".repeat(32),
                  },
                },
                quarantine: {},
                currentRevision: "rev-auto-stale",
                pendingRevision: null,
              }),
            ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/status output|queued objective|completed/i)
  })

  test("autonomous-run scenario rejects runs that use configure instead of the required start path", async () => {
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
                      verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                    },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        missingVerificationCommands: [],
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
                      verification: [
                        {
                          command: AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND,
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
              stdout: buildToolEvent("evolver_autonomous_configure", "ses-auto-2b", AUTONOMOUS_RUN_CONFIGURE_INPUT),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
            return {
              stdout: buildToolEvent("evolver_autonomous_status", "ses-auto-2b", {}),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: buildToolEvent(
              "evolver_status",
              "ses-auto-2b",
              {},
              JSON.stringify({
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
              }),
            ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/turn-1 start-only path/i)
  })

  test("autonomous-run scenario rejects runs that skip the required turn-2 autonomous status read", async () => {
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
                      verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                    },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        missingVerificationCommands: [],
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
                      verification: [
                        {
                          command: AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND,
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
              stdout: buildToolEvent("evolver_autonomous_start", "ses-auto-3", {}),
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
    ).rejects.toThrow(/turn-2 autonomous-status/i)
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
                      verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                    },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        missingVerificationCommands: [],
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
                      verification: [
                        {
                          command: AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND,
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
              stdout: buildToolEvent("evolver_autonomous_start", "ses-auto-4", {}),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: [
              '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-auto-4"}',
              '{"type":"tool","tool":"evolver_write_memory","sessionID":"ses-auto-4"}',
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/turn-2 autonomous-status path|mutating tool/i)
  })

  test("autonomous-run scenario rejects runs that add an unexpected fourth turn", async () => {
    const autonomousRunPrompt = await readFile(
      new URL("../../eval/scenarios/autonomous-run.md", import.meta.url),
      "utf8",
    )

    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
        `${autonomousRunPrompt}\n\n---\n\nTurn 4:\n\nSay \"extra turn\".`,
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
                        verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        missingVerificationCommands: [],
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
                      verification: [
                        {
                          command: AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND,
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
              stdout: '{"type":"tool","tool":"evolver_autonomous_start","sessionID":"ses-auto-5"}',
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
            return {
              stdout: '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-auto-5"}',
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 3) {
            return {
              stdout: '{"type":"tool","tool":"evolver_status","sessionID":"ses-auto-5"}',
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
    ).rejects.toThrow(/exactly 3 turns/i)
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
    ).rejects.toThrow(/turn-1 autonomous status path|required status/i)
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
        executeCommand: async ({ command }) => {
          const isFollowupTurn = command.includes("--session")

          return {
            stdout: isFollowupTurn
              ? [
                  '{"type":"tool","tool":"evolver_status","sessionID":"ses-objective-2"}',
                  '{"type":"tool","tool":"evolver_write_memory","sessionID":"ses-objective-2"}',
                ].join("\n")
              : '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-objective-2"}',
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/turn-2 registry status path|mutating tool/i)
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
        executeCommand: async ({ command }) => {
          const isFollowupTurn = command.includes("--session")

          return {
            stdout: isFollowupTurn
              ? [
                  '{"type":"tool","tool":"evolver_status","sessionID":"ses-objective-3"}',
                  '{"type":"tool","tool":"apply_patch","sessionID":"ses-objective-3"}',
                ].join("\n")
              : '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-objective-3"}',
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/turn-2 registry status path|status-only/i)
  })

  test("objective-memory-evidence scenario allows the registry status artifact when the required status reads are the only tools used", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/objective-memory-evidence.md"),
      await readFile(new URL("../../eval/scenarios/objective-memory-evidence.md", import.meta.url), "utf8"),
    )

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "objective-memory-evidence",
      timestamp: "2026-05-02T00-15-00.000Z",
      executeCommand: async ({ workspaceRoot, command }) => {
        await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/registry.json"),
          JSON.stringify(
            {
              skills: {},
              agents: {},
              commands: {},
              memories: {},
              quarantine: {},
              currentRevision: null,
              pendingRevision: "rev-objective-allowed",
            },
            null,
            2,
          ),
        )

        return {
          stdout: command.includes("--session")
            ? '{"type":"tool","tool":"evolver_status","sessionID":"ses-objective-allowed"}'
            : '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-objective-allowed"}',
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }

    expect(resultJson.changedFiles).toEqual([".opencode/oc-evolver/registry.json"])
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
              stdout: '{"type":"tool","tool":"evolver_autonomous_status","sessionID":"ses-objective-4"}',
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
            return {
              stdout: '{"type":"tool","tool":"evolver_status","sessionID":"ses-objective-4"}',
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
    ).rejects.toThrow(/exactly 2 turns/i)
  })

  test("command-runtime scenario unit coverage captures command-owned runtime session artifacts", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/command-runtime.md"),
      await readFile(new URL("../../eval/scenarios/command-runtime.md", import.meta.url), "utf8"),
    )

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "command-runtime",
      timestamp: "2026-04-30T14-30-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })

        const seededRegistry = JSON.parse(
          await readFile(join(workspaceRoot, ".opencode/oc-evolver/registry.json"), "utf8"),
        ) as {
          commands: Record<string, { contentHash?: string }>
          memories: Record<string, { contentHash?: string }>
        }
        const seededSessionRouting = await readFile(join(workspaceRoot, ".opencode/memory/session-routing.md"), "utf8")
        const seededCommandRouting = await readFile(join(workspaceRoot, ".opencode/memory/command-routing.md"), "utf8")
        const seededReviewCommand = await readFile(join(workspaceRoot, ".opencode/commands/review-markdown.md"), "utf8")

        expect(seededRegistry.memories["session-routing"]?.contentHash).toBe(
          createHash("sha256").update(seededSessionRouting).digest("hex"),
        )
        expect(seededRegistry.memories["command-routing"]?.contentHash).toBe(
          createHash("sha256").update(seededCommandRouting).digest("hex"),
        )
        expect(seededRegistry.commands["review-markdown"]?.contentHash).toBe(
          createHash("sha256").update(seededReviewCommand).digest("hex"),
        )
        expect(seededReviewCommand).toContain('Respond with exactly "README.md reviewed." and stop.')

        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/sessions/session-command-runtime-green.json"),
          `${JSON.stringify(
            {
              memories: {
                "command-routing": { storageMode: "memory-and-artifact" },
              },
              operatorGuideApplied: true,
              runtimePolicy: {
                sourceKind: "command",
                sourceName: "review-markdown",
                toolPermissions: { edit: "deny" },
                preferredModel: "openai/gpt-5.4",
              },
            },
            null,
            2,
          )}\n`,
        )
        await writeFile(
          join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
          JSON.stringify({ action: "run_command", status: "success" }) + "\n",
        )

        return {
          stdout: buildToolEvent("evolver_run_command", "session-command-runtime-green", {
            commandName: "review-markdown",
            prompt: "Review README.md.",
          }),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }

    expect(evalHarness.FULL_SCENARIOS).not.toContain("command-runtime")
    expect(resultJson.turnCount).toBe(1)
    expect(resultJson.changedFiles).toContain(".opencode/memory/session-routing.md")
    expect(resultJson.changedFiles).toContain(".opencode/memory/command-routing.md")
    expect(resultJson.changedFiles).toContain(".opencode/commands/review-markdown.md")
    expect(resultJson.changedFiles).toContain(
      ".opencode/oc-evolver/sessions/session-command-runtime-green.json",
    )
  })

  test("command-runtime scenario rejects runs that use the wrong command name", async () => {
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
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/sessions/session-command-runtime-bad-memory.json"),
            `${JSON.stringify({ memories: { "command-routing": { storageMode: "memory-and-artifact" } }, operatorGuideApplied: true, runtimePolicy: { sourceKind: "command", sourceName: "review-markdown", toolPermissions: { edit: "deny" }, preferredModel: "openai/gpt-5.4" } }, null, 2)}\n`,
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            JSON.stringify({ action: "run_command", status: "success" }) + "\n",
          )

          return {
            stdout: buildToolEvent("evolver_run_command", "session-command-runtime-bad-memory", { commandName: "wrong-command", prompt: "Review README.md." }),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/did not run review-markdown against README.md/i)
  })

  test("command-runtime scenario rejects runs that do not persist merged session memory state", async () => {
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
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/sessions/session-command-runtime-bad-session.json"),
            `${JSON.stringify({ memories: {}, operatorGuideApplied: true, runtimePolicy: { sourceKind: "command", sourceName: "review-markdown", toolPermissions: { edit: "deny" }, preferredModel: "openai/gpt-5.4" } }, null, 2)}\n`,
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            JSON.stringify({ action: "run_command", status: "success" }) + "\n",
          )

          return {
            stdout: buildToolEvent("evolver_run_command", "session-command-runtime-bad-session", { commandName: "review-markdown", prompt: "Review README.md." }),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/missing persisted command memory state/i)
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
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/sessions"), { recursive: true })
          await writeFile(
            join(workspaceRoot, ".opencode/commands/review-markdown.md"),
            ["---", "description: Review markdown with missing metadata", "---", "", 'Respond with exactly "README.md reviewed." and stop.', ""].join("\n"),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/sessions/session-command-runtime-bad-doc.json"),
            `${JSON.stringify({ memories: { "command-routing": { storageMode: "memory-and-artifact" } }, operatorGuideApplied: true, runtimePolicy: { sourceKind: "command", sourceName: "review-markdown", toolPermissions: { edit: "deny" }, preferredModel: "openai/gpt-5.4" } }, null, 2)}\n`,
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            JSON.stringify({ action: "run_command", status: "success" }) + "\n",
          )

          return {
            stdout: buildToolEvent("evolver_run_command", "session-command-runtime-bad-doc", { commandName: "review-markdown", prompt: "Review README.md." }),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/command document is missing required command-owned metadata|command-owned metadata/i)
  })

  test("revision-lifecycle scenario unit coverage captures pending-review deletion flow", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/revision-lifecycle.md"),
      await readFile(new URL("../../eval/scenarios/revision-lifecycle.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "revision-lifecycle",
      timestamp: "2026-04-30T14-31-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        executionCount += 1
        await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
        await mkdir(join(workspaceRoot, ".opencode/oc-evolver/revisions"), { recursive: true })

        if (executionCount === 1) {
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }) + "\n",
          )

          return {
            stdout: buildToolEvent("evolver_write_command", "ses-revision-lifecycle", { commandName: "review-markdown" }),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        if (executionCount === 2) {
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
            join(workspaceRoot, ".opencode/oc-evolver/revisions/rev-first.json"),
            JSON.stringify({ revisionID: "rev-first" }, null, 2),
          )
          await writeFile(
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }),
              JSON.stringify({ action: "promote", status: "success", revisionID: "rev-first" }),
            ].join("\n") + "\n",
          )

          return {
            stdout: buildToolEvent("evolver_promote", "ses-revision-lifecycle", {}),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        if (executionCount === 3) {
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
            ].join("\n") + "\n",
          )

          return {
            stdout: buildToolEvent("evolver_delete_artifact", "ses-revision-lifecycle", { kind: "command", name: "review-markdown" }),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        if (executionCount === 4) {
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
            join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
            [
              JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }),
              JSON.stringify({ action: "promote", status: "success", revisionID: "rev-first" }),
              JSON.stringify({ action: "delete_artifact", status: "success", revisionID: "rev-delete", target: "command:review-markdown" }),
              JSON.stringify({ action: "review_pending", status: "success", target: ".opencode/oc-evolver/pending-review.json" }),
            ].join("\n") + "\n",
          )

          return {
            stdout: buildToolEvent(
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
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        if (executionCount === 5) {
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
            ].join("\n") + "\n",
          )

          return {
            stdout: buildToolEvent("evolver_reject", "ses-revision-lifecycle", {}),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

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
          stdout: buildToolEvent("evolver_prune", "ses-revision-lifecycle", {}),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
    }

    expect(evalHarness.FULL_SCENARIOS).not.toContain("revision-lifecycle")
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

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "revision-lifecycle",
        timestamp: "2026-04-30T14-31-30.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1
          await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
          await mkdir(join(workspaceRoot, ".opencode/oc-evolver/revisions"), { recursive: true })

          if (executionCount === 1) {
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }) + "\n",
            )

            return {
              stdout: buildToolEvent("evolver_write_command", "ses-revision-lifecycle-bad", { commandName: "review-markdown" }),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
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
              join(workspaceRoot, ".opencode/oc-evolver/revisions/rev-first.json"),
              JSON.stringify({ revisionID: "rev-first" }, null, 2),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              [
                JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }),
                JSON.stringify({ action: "promote", status: "success", revisionID: "rev-first" }),
              ].join("\n") + "\n",
            )

            return {
              stdout: buildToolEvent("evolver_promote", "ses-revision-lifecycle-bad", {}),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 3) {
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
              ].join("\n") + "\n",
            )

            return {
              stdout: buildToolEvent("evolver_delete_artifact", "ses-revision-lifecycle-bad", { kind: "command", name: "review-markdown" }),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 4) {
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
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              [
                JSON.stringify({ action: "write_command", status: "success", revisionID: "rev-first" }),
                JSON.stringify({ action: "promote", status: "success", revisionID: "rev-first" }),
                JSON.stringify({ action: "delete_artifact", status: "success", revisionID: "rev-delete", target: "command:review-markdown" }),
                JSON.stringify({ action: "review_pending", status: "success", target: ".opencode/oc-evolver/pending-review.json" }),
              ].join("\n") + "\n",
            )

            return {
              stdout: buildToolEvent(
                "evolver_review_pending",
                "ses-revision-lifecycle-bad",
                {},
                JSON.stringify({
                  currentRevisionID: "rev-first",
                  pendingRevisionID: "rev-delete",
                  changedArtifacts: { skills: [], agents: [], commands: ["review-markdown"], memories: [] },
                }),
              ),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 5) {
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
              ].join("\n") + "\n",
            )

            return {
              stdout: buildToolEvent("evolver_reject", "ses-revision-lifecycle-bad", {}),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

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
            stdout: buildToolEvent("evolver_prune", "ses-revision-lifecycle-bad", {}),
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
          return {
            stdout: buildToolEvent("evolver_autonomous_configure", "ses-autonomous-control", {
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
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        if (executionCount === 2) {
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
                latestLearning: {
                  summary: "The last autonomous iteration was skipped_unrunnable: no bounded objective available",
                  remainingObjectives: [],
                  lastDecision: "skipped_unrunnable",
                  rejectionReason: "no bounded objective available",
                  failedVerificationCommands: [],
                  failedEvaluationScenarios: [],
                  changedArtifacts: [],
                },
                objectives: [],
                iterations: [
                  {
                    startedAt: "2026-04-30T14:32:05.000Z",
                    completedAt: "2026-04-30T14:32:05.000Z",
                    sessionID: null,
                    decision: "skipped_unrunnable",
                    pendingRevisionID: null,
                    promotedRevisionID: null,
                    rejectionReason: "no bounded objective available",
                    prompt:
                      "Review the current project state, consult autonomous-loop status and prior learning, make one concrete improvement, and leave the workspace in a verified state.",
                    objectivePrompt: null,
                    verification: [],
                    evaluations: [],
                    changedArtifacts: [],
                  },
                ],
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
            stdout: buildToolEvent(
              "evolver_autonomous_pause",
              "ses-autonomous-control",
              {},
              JSON.stringify({
                config: {
                  enabled: true,
                  paused: true,
                  intervalMs: 60_000,
                },
                latestLearning: {
                  lastDecision: "skipped_unrunnable",
                  rejectionReason: "no bounded objective available",
                },
              }),
            ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        if (executionCount === 3) {
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
                latestLearning: {
                  summary: "The last autonomous iteration was skipped_unrunnable: no bounded objective available",
                  remainingObjectives: [],
                  lastDecision: "skipped_unrunnable",
                  rejectionReason: "no bounded objective available",
                  failedVerificationCommands: [],
                  failedEvaluationScenarios: [],
                  changedArtifacts: [],
                },
                objectives: [],
                iterations: [
                  {
                    startedAt: "2026-04-30T14:32:05.000Z",
                    completedAt: "2026-04-30T14:32:05.000Z",
                    sessionID: null,
                    decision: "skipped_unrunnable",
                    pendingRevisionID: null,
                    promotedRevisionID: null,
                    rejectionReason: "no bounded objective available",
                    prompt:
                      "Review the current project state, consult autonomous-loop status and prior learning, make one concrete improvement, and leave the workspace in a verified state.",
                    objectivePrompt: null,
                    verification: [],
                    evaluations: [],
                    changedArtifacts: [],
                  },
                ],
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
            stdout: buildToolEvent(
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
                latestLearning: {
                  lastDecision: "skipped_unrunnable",
                  rejectionReason: "no bounded objective available",
                },
              }),
            ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        return {
          stdout: buildToolEvent(
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
              latestLearning: {
                lastDecision: "skipped_unrunnable",
                rejectionReason: "no bounded objective available",
              },
              iterations: [
                {
                  decision: "skipped_unrunnable",
                  rejectionReason: "no bounded objective available",
                  changedArtifacts: [],
                },
                {
                  decision: "skipped_unrunnable",
                  rejectionReason: "no bounded objective available",
                  changedArtifacts: [],
                },
              ],
            }),
          ),
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
    expect(resultJson.turnCount).toBe(4)
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/autonomous-loop.json")
    expect(resultJson.changedFiles).not.toContain(".opencode/oc-evolver/autonomous-loop-paused.json")
  })

  test("autonomous-control scenario rejects runs whose pause output does not reflect the paused configured state", async () => {
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
            return {
              stdout: buildToolEvent("evolver_autonomous_configure", "ses-autonomous-control-bad", {
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
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
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
              stdout: buildToolEvent(
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
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 3) {
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
              stdout: buildToolEvent(
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
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: buildToolEvent(
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
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/paused configured state|paused/i)
  })

  test("autonomous-startup scenario is part of the default sweep and captures startup restoration evidence", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-startup.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-startup.md", import.meta.url), "utf8"),
    )

    const activationCalls: Array<Record<string, unknown>> = []
    let scenarioWorkspaceRoot = ""
    let executionCount = 0

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "autonomous-startup",
      timestamp: "2026-04-30T14-33-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        executionCount += 1
        scenarioWorkspaceRoot = workspaceRoot

        if (executionCount === 1) {
          const seededLoopState = JSON.parse(
            await readFile(join(workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"), "utf8"),
          ) as {
            config?: {
              enabled?: boolean
              paused?: boolean
              intervalMs?: number
            }
          }

          expect(seededLoopState.config).toMatchObject({
            enabled: true,
            paused: false,
            intervalMs: 60_000,
          })

          const hooks = await (createOCEvolverPlugin as any)(undefined, {
            activateAutonomousLoop: async (input: Record<string, unknown>) =>
              activateAutonomousLoop(input as any, {
                startWorker: (config: Record<string, unknown>) => {
                  activationCalls.push(config)

                  return {
                    once() {},
                    terminate: async () => 0,
                  } as never
                },
              }),
          })({
            client: {
              session: {
                prompt: async () => ({ info: {}, parts: [] }),
              },
            },
            project: {
              id: "eval-startup-project",
              worktree: workspaceRoot,
            },
            directory: workspaceRoot,
            worktree: workspaceRoot,
            experimental_workspace: {
              register() {},
            },
            serverUrl: new URL("http://localhost:4096"),
            $: {} as never,
          } as never)

          await hooks.config?.({} as never)

          const autonomousStatusOutput = await hooks.tool.evolver_autonomous_status.execute(
            {},
            { sessionID: "ses-autonomous-startup" } as never,
          )

          return {
            stdout: buildToolEvent(
              "evolver_autonomous_status",
              "ses-autonomous-startup",
              {},
              autonomousStatusOutput,
            ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        }

        const hooks = await createOCEvolverPlugin(undefined, {})({
          client: {
            session: {
              prompt: async () => ({ info: {}, parts: [] }),
            },
          },
          project: {
            id: "eval-startup-project",
            worktree: workspaceRoot,
          },
          directory: workspaceRoot,
          worktree: workspaceRoot,
          experimental_workspace: {
            register() {},
          },
          serverUrl: new URL("http://localhost:4096"),
          $: {} as never,
        } as never)

        const tool = hooks.tool!
        const registryStatusOutput = await tool.evolver_status!.execute(
          {},
          { sessionID: "ses-autonomous-startup" } as never,
        )

        return {
          stdout: buildToolEvent("evolver_status", "ses-autonomous-startup", {}, registryStatusOutput),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }

    expect(resultJson.turnCount).toBe(2)
    expect(DEFAULT_SCENARIOS).toContain("autonomous-startup")
    expect(activationCalls).toHaveLength(1)
    expect(activationCalls[0]).toMatchObject({
      repoRoot: scenarioWorkspaceRoot,
      pluginFilePath: join(scenarioWorkspaceRoot, ".opencode/plugins/oc-evolver.ts"),
      intervalMs: 60_000,
      verificationCommands: [["bun", "run", "typecheck"]],
      evaluationScenarios: ["autonomous-run"],
    })
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/audit.ndjson")
  })

  test("autonomous-startup scenario rejects runs that lack startup restoration audit evidence", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-startup.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-startup.md", import.meta.url), "utf8"),
    )

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-startup",
        timestamp: "2026-04-30T14-33-30.000Z",
        executeCommand: async () => {
          return {
            stdout: buildToolEvent(
              "evolver_autonomous_status",
              "ses-autonomous-startup-bad",
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
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/autonomous_restore|startup restoration/i)
  })

  test("autonomous-startup scenario rejects stale status output even when files look restored", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-startup.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-startup.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-startup",
        timestamp: "2026-04-30T14-34-00.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1

          if (executionCount === 1) {
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              JSON.stringify({ action: "autonomous_restore", status: "success", target: ".opencode/oc-evolver/autonomous-loop.json" }) + "\n",
            )

            return {
              stdout: buildToolEvent(
                "evolver_autonomous_status",
                "ses-autonomous-startup-stale",
                {},
                JSON.stringify({
                  config: {
                    enabled: false,
                    paused: true,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: [],
                  },
                }),
              ),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: buildToolEvent(
              "evolver_status",
              "ses-autonomous-startup-stale",
              {},
              JSON.stringify({
                skills: {},
                agents: {},
                commands: {},
                memories: {},
                quarantine: {},
                currentRevision: null,
                pendingRevision: "rev-pending-startup",
              }),
            ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/status output|enabled|paused|interval|pending/i)
  })

  test("autonomous-run scenario rejects stale evolver_status output even when autonomous status is correct", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-run.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-run.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-run",
        timestamp: "2026-04-30T14-16-45.000Z",
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
                  lastSessionID: "ses-auto-status-stale",
                  latestLearning: {
                    summary: "The last autonomous iteration was promoted at revision rev-auto-status-stale.",
                    remainingObjectives: [],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "completed",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                        verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                        missingChangedArtifacts: [],
                        missingEvaluationScenarios: [],
                        missingVerificationCommands: [],
                        checkedAt: new Date(0).toISOString(),
                      },
                      attempts: 1,
                      consecutiveFailures: 0,
                      updatedAt: new Date(0).toISOString(),
                      lastSessionID: "ses-auto-status-stale",
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
                      verification: [
                        {
                          command: AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND,
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
                      revisionID: "rev-auto-status-stale",
                      contentHash: "ab".repeat(32),
                    },
                  },
                  quarantine: {},
                  currentRevision: "rev-auto-status-stale",
                  pendingRevision: null,
                },
                null,
                2,
              ),
            )
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              '{"action":"promote","status":"success","revisionID":"rev-auto-status-stale"}\n',
            )

            return {
              stdout: buildToolEvent("evolver_autonomous_start", "ses-auto-status-stale", {}),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          if (executionCount === 2) {
            return {
              stdout: buildToolEvent(
                "evolver_autonomous_status",
                "ses-auto-status-stale",
                {},
                JSON.stringify({
                  config: {
                    enabled: true,
                    paused: false,
                    intervalMs: 0,
                    verificationCommands: [],
                    evaluationScenarios: ["smoke"],
                  },
                  objectives: [
                    {
                      prompt: AUTONOMOUS_RUN_OBJECTIVE_PROMPT,
                      status: "completed",
                      completionCriteria: {
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        evaluationScenarios: ["objective-memory-evidence"],
                        verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      },
                      lastCompletionEvidence: {
                        satisfied: true,
                        changedArtifacts: ["memory:autonomous-evidence-memory"],
                        passedEvaluationScenarios: ["objective-memory-evidence", "smoke"],
                        passedVerificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
                      },
                    },
                  ],
                }),
              ),
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: buildToolEvent("evolver_status", "ses-auto-status-stale", {}, JSON.stringify({
              skills: {},
              agents: {},
              commands: {},
              memories: {},
              quarantine: {},
              currentRevision: null,
              pendingRevision: "rev-pending-status-stale",
            })),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/status output|currentRevision|pendingRevision/i)
  })

  test("autonomous-startup scenario rejects stale evolver_status output even when autonomous status is correct", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-startup.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-startup.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-startup",
        timestamp: "2026-04-30T14-34-15.000Z",
        executeCommand: async ({ workspaceRoot }) => {
          executionCount += 1

          if (executionCount === 1) {
            await writeFile(
              join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"),
              JSON.stringify({ action: "autonomous_restore", status: "success", target: ".opencode/oc-evolver/autonomous-loop.json" }) + "\n",
            )

            return {
              stdout: buildToolEvent(
                "evolver_autonomous_status",
                "ses-autonomous-startup-status-stale",
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
              stderr: "",
              exitCode: 0,
            } satisfies EvalCommandResult
          }

          return {
            stdout: buildToolEvent("evolver_status", "ses-autonomous-startup-status-stale", {}, JSON.stringify({
              skills: {},
              agents: {},
              commands: {},
              memories: {},
              quarantine: {},
              currentRevision: "rev-unexpected-startup",
              pendingRevision: "rev-pending-startup",
            })),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/status output|currentRevision|pendingRevision/i)
  })

  test("autonomous-preview scenario captures the bounded next-iteration preview without mutating the loop", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-preview.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-preview.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "autonomous-preview",
      timestamp: "2026-05-01T10-00-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        const hooks = await createOCEvolverPlugin(undefined, {})({
          client: {
            session: {
              prompt: async () => ({ info: {}, parts: [] }),
            },
          },
          project: {
            id: "eval-preview-project",
            worktree: workspaceRoot,
          },
          directory: workspaceRoot,
          worktree: workspaceRoot,
          experimental_workspace: {
            register() {},
          },
          serverUrl: new URL("http://localhost:4096"),
          $: {} as never,
        } as never)
        const tool = hooks.tool!

        executionCount += 1

        return {
          stdout:
            executionCount === 1
              ? buildToolEvent(
                  "evolver_autonomous_preview",
                  "ses-autonomous-preview",
                  {},
                  await tool.evolver_autonomous_preview!.execute({}, { sessionID: "ses-autonomous-preview" } as never),
                )
              : buildToolEvent(
                  "evolver_autonomous_status",
                  "ses-autonomous-preview",
                  {},
                  await tool.evolver_autonomous_status!.execute({}, { sessionID: "ses-autonomous-preview" } as never),
                ),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }

    expect(resultJson.turnCount).toBe(2)
    expect(resultJson.changedFiles).toEqual([".opencode/oc-evolver/autonomous-loop.json"])
  })

  test("autonomous-preview scenario rejects stale preview output even when status remains queued", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-preview.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-preview.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-preview",
        timestamp: "2026-05-01T10-00-30.000Z",
        executeCommand: async () => {
          executionCount += 1

          return {
            stdout:
              executionCount === 1
                ? buildToolEvent(
                    "evolver_autonomous_preview",
                    "ses-autonomous-preview-stale",
                    {},
                    JSON.stringify({
                      wouldRun: false,
                      wouldSkipReason: "no bounded objective available",
                      selectedObjective: null,
                      selectedObjectiveSource: null,
                      selectedObjectiveRationale: null,
                      mutationPrompt: null,
                      verificationCommands: [],
                      evaluationScenarios: [],
                      config: {
                        enabled: false,
                        paused: true,
                        intervalMs: 0,
                      },
                      lockHeld: false,
                      runtimeContractCompatible: true,
                      runtimeContractDetail: null,
                      pendingObjectives: [],
                    }),
                  )
                : buildToolEvent(
                    "evolver_autonomous_status",
                    "ses-autonomous-preview-stale",
                    {},
                    JSON.stringify({
                      config: {
                        enabled: true,
                        paused: false,
                        intervalMs: 0,
                        verificationCommands: [["bun", "run", "typecheck"]],
                        evaluationScenarios: ["smoke"],
                      },
                      objectives: [
                        {
                          prompt: AUTONOMOUS_PREVIEW_OBJECTIVE_PROMPT,
                          status: "pending",
                        },
                      ],
                      iterations: [],
                    }),
                  ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/preview output|selected objective|wouldRun/i)
  })

  test("autonomous-metrics scenario captures structured loop metrics without mutating history", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-metrics.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-metrics.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "autonomous-metrics",
      timestamp: "2026-05-01T10-01-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        const hooks = await createOCEvolverPlugin(undefined, {})({
          client: {
            session: {
              prompt: async () => ({ info: {}, parts: [] }),
            },
          },
          project: {
            id: "eval-metrics-project",
            worktree: workspaceRoot,
          },
          directory: workspaceRoot,
          worktree: workspaceRoot,
          experimental_workspace: {
            register() {},
          },
          serverUrl: new URL("http://localhost:4096"),
          $: {} as never,
        } as never)
        const tool = hooks.tool!

        executionCount += 1

        return {
          stdout:
            executionCount === 1
              ? buildToolEvent(
                  "evolver_autonomous_metrics",
                  "ses-autonomous-metrics",
                  {},
                  await tool.evolver_autonomous_metrics!.execute({}, { sessionID: "ses-autonomous-metrics" } as never),
                )
              : buildToolEvent(
                  "evolver_autonomous_status",
                  "ses-autonomous-metrics",
                  {},
                  await tool.evolver_autonomous_status!.execute({}, { sessionID: "ses-autonomous-metrics" } as never),
                ),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }

    expect(resultJson.turnCount).toBe(2)
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/autonomous-loop.json")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/registry.json")
  })

  test("autonomous-metrics scenario rejects stale aggregate counts", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-metrics.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-metrics.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-metrics",
        timestamp: "2026-05-01T10-01-30.000Z",
        executeCommand: async () => {
          executionCount += 1

          return {
            stdout:
              executionCount === 1
                ? buildToolEvent(
                    "evolver_autonomous_metrics",
                    "ses-autonomous-metrics-stale",
                    {},
                    JSON.stringify({
                      totalIterations: 0,
                      promotedCount: 0,
                      rejectedCount: 0,
                      rolledBackCount: 0,
                      skippedCount: 0,
                      mutationFailedCount: 0,
                      noPendingRevisionCount: 0,
                      promotionRate: 0,
                      avgIterationDurationMs: 0,
                      lastIterationDurationMs: null,
                      objectivesCompleted: 0,
                      objectivesPending: 0,
                      objectivesQuarantined: 0,
                      latestIteration: null,
                      since: new Date(0).toISOString(),
                    }),
                  )
                : buildToolEvent(
                    "evolver_autonomous_status",
                    "ses-autonomous-metrics-stale",
                    {},
                    JSON.stringify({
                      objectives: [
                        { prompt: "Completed objective", status: "completed" },
                        { prompt: "Pending objective", status: "pending" },
                        { prompt: "Quarantined objective", status: "quarantined" },
                      ],
                      iterations: [
                        { decision: "promoted" },
                        { decision: "rejected" },
                        { decision: "skipped_unrunnable" },
                        { decision: "rolled_back" },
                      ],
                    }),
                  ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/metrics output|totalIterations|promotionRate/i)
  })

  test("autonomous-stop scenario captures the disabled paused terminal state", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-stop.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-stop.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    const result = await runEvaluationScenario({
      repoRoot,
      scenarioName: "autonomous-stop",
      timestamp: "2026-05-01T10-02-00.000Z",
      executeCommand: async ({ workspaceRoot }) => {
        const hooks = await createOCEvolverPlugin(undefined, {})({
          client: {
            session: {
              prompt: async () => ({ info: {}, parts: [] }),
            },
          },
          project: {
            id: "eval-stop-project",
            worktree: workspaceRoot,
          },
          directory: workspaceRoot,
          worktree: workspaceRoot,
          experimental_workspace: {
            register() {},
          },
          serverUrl: new URL("http://localhost:4096"),
          $: {} as never,
        } as never)
        const tool = hooks.tool!

        executionCount += 1

        return {
          stdout:
            executionCount === 1
              ? buildToolEvent(
                  "evolver_autonomous_stop",
                  "ses-autonomous-stop",
                  {},
                  await tool.evolver_autonomous_stop!.execute({}, { sessionID: "ses-autonomous-stop" } as never),
                )
              : buildToolEvent(
                  "evolver_autonomous_status",
                  "ses-autonomous-stop",
                  {},
                  await tool.evolver_autonomous_status!.execute({}, { sessionID: "ses-autonomous-stop" } as never),
                ),
          stderr: "",
          exitCode: 0,
        } satisfies EvalCommandResult
      },
    })

    const resultJson = JSON.parse(await readFile(join(result.resultDir, "result.json"), "utf8")) as {
      changedFiles: string[]
      turnCount: number
    }

    expect(resultJson.turnCount).toBe(2)
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/autonomous-loop.json")
    expect(resultJson.changedFiles).toContain(".opencode/oc-evolver/audit.ndjson")
  })

  test("autonomous-stop scenario rejects stale stopped-state output", async () => {
    await writeFile(
      join(repoRoot, "eval/scenarios/autonomous-stop.md"),
      await readFile(new URL("../../eval/scenarios/autonomous-stop.md", import.meta.url), "utf8"),
    )

    let executionCount = 0

    await expect(
      runEvaluationScenario({
        repoRoot,
        scenarioName: "autonomous-stop",
        timestamp: "2026-05-01T10-02-30.000Z",
        executeCommand: async () => {
          executionCount += 1

          return {
            stdout:
              executionCount === 1
                ? buildToolEvent(
                    "evolver_autonomous_stop",
                    "ses-autonomous-stop-stale",
                    {},
                    JSON.stringify({
                      config: {
                        enabled: true,
                        paused: false,
                        intervalMs: 0,
                      },
                      activation: {
                        mode: "worker",
                      },
                    }),
                  )
                : buildToolEvent(
                    "evolver_autonomous_status",
                    "ses-autonomous-stop-stale",
                    {},
                    JSON.stringify({
                      config: {
                        enabled: true,
                        paused: false,
                        intervalMs: 0,
                        verificationCommands: [["bun", "run", "typecheck"]],
                        evaluationScenarios: ["smoke"],
                      },
                      objectives: [],
                      iterations: [],
                    }),
                  ),
            stderr: "",
            exitCode: 0,
          } satisfies EvalCommandResult
        },
      }),
    ).rejects.toThrow(/stopped|disabled|paused|autonomous_stop/i)
  })
})
