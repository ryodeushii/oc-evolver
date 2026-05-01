import { spawn } from "node:child_process"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { syncPluginIntoFixture } from "./sync-plugin-into-fixture.ts"

export type EvalCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type ExecuteCommand = (input: {
  workspaceRoot: string
  prompt: string
  command: string[]
}) => Promise<EvalCommandResult>

type EvaluationResult = {
  scenarioName: string
  resultDir: string
  workspaceRoot: string
  stdout: string
  stderr: string
  exitCode: number
  changedFiles: string[]
}

type EvaluationTurn = {
  turnNumber: number
  prompt: string
  command: string[]
  exitCode: number
  sessionID: string | null
}

type ParsedEvalResponse = unknown[] | { raw: string }
const OUTER_AUTONOMOUS_MUTATING_TOOLS = new Set([
  "evolver_write_skill",
  "evolver_write_agent",
  "evolver_write_command",
  "evolver_write_memory",
  "evolver_promote",
  "evolver_reject",
  "evolver_rollback",
  "evolver_delete_artifact",
  "evolver_prune",
])
const AUTONOMOUS_RUN_TURN_ONE_TOOLS = [
  "evolver_autonomous_configure",
  "evolver_autonomous_start",
] as const
const AUTONOMOUS_RUN_TURN_TWO_TOOLS = [
  "evolver_autonomous_status",
  "evolver_status",
] as const
const AUTONOMOUS_STARTUP_TURN_ONE_TOOLS = [
  "evolver_autonomous_status",
  "evolver_status",
] as const
const OBJECTIVE_MEMORY_EVIDENCE_TOOLS = [
  "evolver_autonomous_status",
  "evolver_status",
] as const
const COMMAND_RUNTIME_TOOLS = [
  "evolver_write_memory",
  "evolver_write_memory",
  "evolver_apply_memory",
  "evolver_write_command",
  "evolver_run_command",
] as const
const REVISION_LIFECYCLE_TURN_ONE_TOOLS = [
  "evolver_write_command",
  "evolver_promote",
  "evolver_delete_artifact",
  "evolver_review_pending",
] as const
const REVISION_LIFECYCLE_TURN_TWO_TOOLS = [
  "evolver_reject",
  "evolver_prune",
] as const
const AUTONOMOUS_CONTROL_TURN_ONE_TOOLS = [
  "evolver_autonomous_configure",
  "evolver_autonomous_pause",
] as const
const AUTONOMOUS_CONTROL_TURN_TWO_TOOLS = [
  "evolver_autonomous_resume",
  "evolver_autonomous_status",
] as const
const AUTONOMOUS_CONTROL_CONFIGURE_INPUT = {
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
} as const
const AUTONOMOUS_RUN_OBJECTIVE_PROMPT =
  'Make exactly one mutation by calling evolver_write_memory with memoryName "autonomous-evidence-memory" and document "---\\nname: autonomous-evidence-memory\\ndescription: Autonomous evaluation evidence memory.\\n---\\n\\nAutonomous evaluation evidence memory.". After the write succeeds, respond with exactly one short confirmation sentence. Do not call evolver_autonomous_run. Do not call status tools before the write.'
const AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND = ["bun", "--version"]
const AUTONOMOUS_RUN_COMPLETION_CRITERIA = {
  changedArtifacts: ["memory:autonomous-evidence-memory"],
  evaluationScenarios: ["objective-memory-evidence"],
  verificationCommands: [AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND],
} as const
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
      completionCriteria: AUTONOMOUS_RUN_COMPLETION_CRITERIA,
    },
  ],
  replaceObjectives: true,
  enabled: true,
  paused: false,
} as const

export const DEFAULT_SCENARIOS = [
  "smoke",
  "create-skill",
  "create-agent",
  "command-runtime",
  "reuse-skill",
  "revision-lifecycle",
  "policy-deny",
  "invalid-artifact",
  "memory-guided-write",
  "artifact-only-deny",
  "autonomous-run",
  "autonomous-control",
  "autonomous-startup",
  "rollback",
]

const IGNORED_CHANGED_FILE_PREFIXES = [".opencode/node_modules/"]
const IGNORED_CHANGED_FILES = new Set([
  ".opencode/.gitignore",
  ".opencode/package.json",
  ".opencode/package-lock.json",
])

export async function runEvaluationScenario(input: {
  repoRoot: string
  scenarioName: string
  timestamp?: string
  executeCommand?: ExecuteCommand
}): Promise<EvaluationResult> {
  const executeCommand = input.executeCommand ?? executeOpencodeRun
  const baseFixtureRoot = join(input.repoRoot, "eval/fixtures/base")
  const scenarioPath = join(input.repoRoot, "eval/scenarios", `${input.scenarioName}.md`)
  const prompt = await readFile(scenarioPath, "utf8")
  const prompts = parseScenarioPrompts(prompt)

  await syncPluginIntoFixture({ repoRoot: input.repoRoot })

  const workspaceParent = await mkdtemp(join(tmpdir(), `oc-evolver-${input.scenarioName}-`))
  const workspaceRoot = join(workspaceParent, "workspace")

  await cp(baseFixtureRoot, workspaceRoot, { recursive: true })
  await seedScenarioWorkspace(input.scenarioName, workspaceRoot)

  const timestamp = input.timestamp ?? new Date().toISOString().replaceAll(":", "-")
  const resultDir = join(input.repoRoot, "eval/results", input.scenarioName, timestamp)
  const turns: EvaluationTurn[] = []
  const parsedResponses: ParsedEvalResponse[] = []
  let combinedStdout = ""
  let combinedStderr = ""
  let exitCode = 0
  let sessionID: string | null = null

  for (const [index, turnPrompt] of prompts.entries()) {
    const command = buildOpencodeRunCommand({
      workspaceRoot,
      prompt: turnPrompt,
      sessionID,
    })
    const execution = await executeCommand({
      workspaceRoot,
      prompt: turnPrompt,
      command,
    })
    const parsedResponse = parseOpencodeJsonStream(execution.stdout)
    const nextSessionID: string | null = extractSessionID(parsedResponse) ?? sessionID

    if (index > 0 && !nextSessionID) {
      throw new Error(`scenario ${input.scenarioName} lost the continued session id at turn ${index + 1}`)
    }

    turns.push({
      turnNumber: index + 1,
      prompt: turnPrompt,
      command,
      exitCode: execution.exitCode,
      sessionID: nextSessionID,
    })

    parsedResponses.push(parsedResponse)

    combinedStdout += execution.stdout
    combinedStderr += execution.stderr
    exitCode = execution.exitCode
    sessionID = nextSessionID

    if (execution.exitCode !== 0) {
      break
    }
  }

  const changedFiles = await diffDirectories(baseFixtureRoot, workspaceRoot)

  await mkdir(resultDir, { recursive: true })
  await writeFile(join(resultDir, "stdout.txt"), combinedStdout)
  await writeFile(join(resultDir, "stderr.txt"), combinedStderr)
  await writeFile(
    join(resultDir, "result.json"),
    `${JSON.stringify(
      {
        scenarioName: input.scenarioName,
        workspaceRoot,
        exitCode,
        command: turns.at(-1)?.command ?? [],
        changedFiles,
        turnCount: turns.length,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(join(resultDir, "response.json"), `${JSON.stringify(parsedResponses, null, 2)}\n`)
  await writeFile(join(resultDir, "turns.json"), `${JSON.stringify(turns, null, 2)}\n`)

  const auditSourcePath = join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson")
  const registrySourcePath = join(workspaceRoot, ".opencode/oc-evolver/registry.json")

  try {
    const auditLog = await readFile(auditSourcePath, "utf8")
    await writeFile(join(resultDir, "audit.ndjson"), auditLog)
  } catch {
    await writeFile(join(resultDir, "audit.ndjson"), "")
  }

  try {
    const registryState = await readFile(registrySourcePath, "utf8")
    await writeFile(join(resultDir, "registry.json"), registryState)
  } catch {
    await writeFile(join(resultDir, "registry.json"), "{}\n")
  }

  await assertProtectedPluginFileUnchanged(baseFixtureRoot, workspaceRoot)
  await assertScenarioArtifacts({
    scenarioName: input.scenarioName,
    workspaceRoot,
    changedFiles,
    parsedResponses,
    turns,
  })

  return {
    scenarioName: input.scenarioName,
    resultDir,
    workspaceRoot,
    stdout: combinedStdout,
    stderr: combinedStderr,
    exitCode,
    changedFiles,
  }
}

function buildOpencodeRunCommand(input: {
  workspaceRoot: string
  prompt: string
  sessionID: string | null
}) {
  const command = [
    "opencode",
    "run",
    "--format",
    "json",
    "--dir",
    input.workspaceRoot,
    "--dangerously-skip-permissions",
  ]

  if (input.sessionID) {
    command.push("--session", input.sessionID)
  }

  command.push(input.prompt)

  return command
}

async function executeOpencodeRun(input: {
  workspaceRoot: string
  prompt: string
  command: string[]
}): Promise<EvalCommandResult> {
  const [executable, ...args] = input.command

  if (!executable) {
    throw new Error("evaluation command is missing an executable")
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: input.workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      })
    })
  })
}

async function diffDirectories(baseRoot: string, candidateRoot: string) {
  const baseFiles = await collectFileMap(baseRoot)
  const candidateFiles = await collectFileMap(candidateRoot)
  const changedFiles = new Set<string>()

  for (const [relativePath, candidateContent] of candidateFiles.entries()) {
    const baseContent = baseFiles.get(relativePath)

    if (
      (baseContent === undefined || baseContent !== candidateContent) &&
      !shouldIgnoreChangedFile(relativePath)
    ) {
      changedFiles.add(relativePath)
    }
  }

  for (const relativePath of baseFiles.keys()) {
    if (!candidateFiles.has(relativePath) && !shouldIgnoreChangedFile(relativePath)) {
      changedFiles.add(relativePath)
    }
  }

  return [...changedFiles].sort((left, right) => left.localeCompare(right))
}

async function collectFileMap(rootPath: string) {
  const fileMap = new Map<string, string>()

  await walkDirectory(rootPath, rootPath, async (filePath) => {
    fileMap.set(relative(rootPath, filePath).replaceAll("\\", "/"), await readFile(filePath, "utf8"))
  })

  return fileMap
}

function parseOpencodeJsonStream(stdout: string) {
  const events: unknown[] = []

  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim()

    if (!trimmedLine) {
      continue
    }

    try {
      events.push(JSON.parse(trimmedLine))
    } catch {
      return {
        raw: stdout,
      }
    }
  }

  return events
}

function extractSessionID(parsedResponse: unknown) {
  if (!Array.isArray(parsedResponse)) {
    return null
  }

  for (const event of parsedResponse) {
    if (
      typeof event === "object" &&
      event !== null &&
      "sessionID" in event &&
      typeof event.sessionID === "string"
    ) {
      return event.sessionID
    }
  }

  return null
}

function parseScenarioPrompts(promptDocument: string) {
  return promptDocument
    .split(/^\s*---\s*$/m)
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0)
}

async function seedScenarioWorkspace(scenarioName: string, workspaceRoot: string) {
  switch (scenarioName) {
    case "invalid-artifact": {
      const brokenSkillRoot = join(workspaceRoot, ".opencode/skills/broken-skill")

      await mkdir(brokenSkillRoot, { recursive: true })
      await writeFile(
        join(brokenSkillRoot, "SKILL.md"),
        [
          "---",
          "name: broken-skill",
          "---",
          "",
          "This skill is intentionally invalid for evaluation.",
          "",
        ].join("\n"),
      )
      return
    }
    case "autonomous-startup": {
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
      return
    }
    default:
      return
  }
}

async function assertScenarioArtifacts(input: {
  scenarioName: string
  workspaceRoot: string
  changedFiles: string[]
  parsedResponses: ParsedEvalResponse[]
  turns: EvaluationTurn[]
}) {
  const auditEvents = await readAuditEvents(input.workspaceRoot)
  const registry = await readRegistry(input.workspaceRoot)

  switch (input.scenarioName) {
    case "create-skill": {
      const canonicalHelperPath = ".opencode/skills/fixture-refactor/scripts/rewrite_todo_to_note.py"

      if (!input.changedFiles.includes(canonicalHelperPath)) {
        throw new Error(
          `scenario create-skill missing canonical helper artifact: ${canonicalHelperPath}`,
        )
      }

      const helperPaths = registry.skills?.["fixture-refactor"]?.helperPaths

      if (!Array.isArray(helperPaths) || !helperPaths.includes(canonicalHelperPath)) {
        throw new Error(
          `scenario create-skill registry missing canonical helper path: ${canonicalHelperPath}`,
        )
      }

      assertAuditAction(auditEvents, "write_skill", "scenario create-skill missing write_skill audit event")
      return
    }
    case "memory-guided-write": {
      assertAuditAction(auditEvents, "write_memory", "scenario memory-guided-write missing write_memory audit event")

      if (!registry.memories?.["research-routing"]) {
        throw new Error("scenario memory-guided-write registry missing research-routing memory entry")
      }

      const repoLocalMarkdown = input.changedFiles.filter(
        (relativePath) => relativePath.endsWith(".md") && !relativePath.startsWith(".opencode/"),
      )

      if (repoLocalMarkdown.length > 0) {
        throw new Error(
          `scenario memory-guided-write created repo-local markdown: ${repoLocalMarkdown.join(", ")}`,
        )
      }

      return
    }
    case "command-runtime": {
      if (input.turns.length !== 1) {
        throw new Error(`scenario command-runtime expected exactly 1 turn, got ${input.turns.length}`)
      }

      const executedToolSequence = collectExecutedToolSequence(input.parsedResponses[0])
      const toolEvents = collectToolEvents(input.parsedResponses[0])

      assertExactToolSequence(
        executedToolSequence,
        COMMAND_RUNTIME_TOOLS,
        "scenario command-runtime did not follow the required memory-command tool path",
      )

      const writeMemoryEvents = toolEvents.filter((event) => event.tool === "evolver_write_memory")

      if (
        writeMemoryEvents.length !== 2 ||
        readObjectStringField(writeMemoryEvents[0]?.input, "memoryName") !== "session-routing" ||
        readObjectStringField(writeMemoryEvents[1]?.input, "memoryName") !== "command-routing"
      ) {
        throw new Error("scenario command-runtime did not write session-routing then command-routing")
      }

      const applyMemoryEvent = toolEvents.find((event) => event.tool === "evolver_apply_memory")
      const runCommandEvent = toolEvents.find((event) => event.tool === "evolver_run_command")

      if (!areJsonValuesEqual(applyMemoryEvent?.input, { memoryName: "session-routing" })) {
        throw new Error("scenario command-runtime did not apply only the required session-routing memory")
      }

      if (
        readObjectStringField(runCommandEvent?.input, "commandName") !== "review-markdown" ||
        !readObjectStringField(runCommandEvent?.input, "prompt")?.includes("README.md")
      ) {
        throw new Error("scenario command-runtime did not run review-markdown against README.md")
      }

      const writeMemoryAuditEvents = auditEvents.filter(
        (event) => event.action === "write_memory" && event.status === "success",
      )

      if (writeMemoryAuditEvents.length < 2) {
        throw new Error("scenario command-runtime missing both write_memory audit events")
      }

      assertAuditAction(auditEvents, "apply_memory", "scenario command-runtime missing apply_memory audit event")
      assertAuditAction(auditEvents, "write_command", "scenario command-runtime missing write_command audit event")
      assertAuditAction(auditEvents, "run_command", "scenario command-runtime missing run_command audit event")

      if (!registry.memories?.["session-routing"] || !registry.memories?.["command-routing"]) {
        throw new Error("scenario command-runtime registry missing required memory entries")
      }

      if (!registry.commands?.["review-markdown"]) {
        throw new Error("scenario command-runtime registry missing review-markdown command entry")
      }

      const commandSessionID = input.turns[0]?.sessionID

      if (!commandSessionID) {
        throw new Error("scenario command-runtime missing a persisted session id")
      }

      const sessionStatePath = join(
        input.workspaceRoot,
        ".opencode/oc-evolver/sessions",
        `${encodeURIComponent(commandSessionID)}.json`,
      )
      const sessionState = JSON.parse(await readFile(sessionStatePath, "utf8")) as {
        memories?: Record<string, { storageMode?: string }>
        runtimePolicy?: {
          sourceKind?: string
          sourceName?: string
          toolPermissions?: Record<string, string>
          preferredModel?: string
        }
      }

      if (!sessionState.memories?.["session-routing"] || !sessionState.memories?.["command-routing"]) {
        throw new Error("scenario command-runtime missing persisted session and command memory state")
      }

      if (sessionState.runtimePolicy?.sourceKind !== "command") {
        throw new Error("scenario command-runtime missing persisted command runtime policy")
      }

      if (
        sessionState.runtimePolicy?.sourceName !== "review-markdown" ||
        sessionState.runtimePolicy.toolPermissions?.edit !== "deny" ||
        sessionState.runtimePolicy.preferredModel !== "openai/gpt-5.4"
      ) {
        throw new Error("scenario command-runtime persisted the wrong command runtime policy")
      }

      const commandDocument = await readFile(
        join(input.workspaceRoot, ".opencode/commands/review-markdown.md"),
        "utf8",
      )
      const commandFrontmatter = parseFrontmatter(commandDocument)

      const commandPermission =
        commandFrontmatter.permission && typeof commandFrontmatter.permission === "object"
          ? (commandFrontmatter.permission as { edit?: string })
          : null

      if (
        commandFrontmatter.model !== "openai/gpt-5.4" ||
        !Array.isArray(commandFrontmatter.memory) ||
        !commandFrontmatter.memory.includes("command-routing") ||
        !commandPermission ||
        commandPermission.edit !== "deny"
      ) {
        throw new Error("scenario command-runtime command document is missing required command-owned metadata")
      }

      return
    }
    case "artifact-only-deny": {
      assertAuditAction(auditEvents, "write_memory", "scenario artifact-only-deny missing write_memory audit event")
      assertAuditAction(auditEvents, "apply_memory", "scenario artifact-only-deny missing apply_memory audit event")
      assertAuditAction(
        auditEvents,
        "policy_denied",
        "scenario artifact-only-deny missing policy_denied audit event",
        "failure",
      )

      if (
        !input.changedFiles.some(
          (relativePath) =>
            relativePath.startsWith(".opencode/oc-evolver/sessions/") &&
            relativePath.endsWith(".json"),
        )
      ) {
        throw new Error("scenario artifact-only-deny missing persisted session state artifact")
      }

      const repoLocalMarkdown = input.changedFiles.filter(
        (relativePath) => relativePath.endsWith(".md") && !relativePath.startsWith(".opencode/"),
      )

      if (repoLocalMarkdown.length > 0) {
        throw new Error(
          `scenario artifact-only-deny created unexpected durable markdown: ${repoLocalMarkdown.join(", ")}`,
        )
      }

      return
    }
    case "objective-memory-evidence": {
      if (input.turns.length !== 1) {
        throw new Error(`scenario objective-memory-evidence expected exactly 1 turn, got ${input.turns.length}`)
      }

      const executedToolSequence = collectExecutedToolSequence(input.parsedResponses[0])
      const executedTools = new Set(executedToolSequence)

      assertExactToolSequence(
        executedToolSequence,
        OBJECTIVE_MEMORY_EVIDENCE_TOOLS,
        "scenario objective-memory-evidence did not stay status-only",
      )

      assertNoExecutedTools(
        executedTools,
        OUTER_AUTONOMOUS_MUTATING_TOOLS,
        "scenario objective-memory-evidence executed a mutating tool",
      )

      if (input.changedFiles.length > 0) {
        throw new Error(
          `scenario objective-memory-evidence created unexpected durable artifacts: ${input.changedFiles.join(", ")}`,
        )
      }

      return
    }
    case "revision-lifecycle": {
      if (input.turns.length !== 2) {
        throw new Error(`scenario revision-lifecycle expected exactly 2 turns, got ${input.turns.length}`)
      }

      const turnOneToolSequence = collectExecutedToolSequence(input.parsedResponses[0])
      const turnTwoToolSequence = collectExecutedToolSequence(input.parsedResponses[1])

      assertExactToolSequence(
        turnOneToolSequence,
        REVISION_LIFECYCLE_TURN_ONE_TOOLS,
        "scenario revision-lifecycle did not follow the required turn-1 revision review path",
      )
      assertExactToolSequence(
        turnTwoToolSequence,
        REVISION_LIFECYCLE_TURN_TWO_TOOLS,
        "scenario revision-lifecycle did not follow the required turn-2 reject/prune path",
      )

      assertAuditAction(auditEvents, "delete_artifact", "scenario revision-lifecycle missing delete_artifact audit event")
      assertAuditAction(auditEvents, "review_pending", "scenario revision-lifecycle missing review_pending audit event")
      assertAuditAction(auditEvents, "reject", "scenario revision-lifecycle missing reject audit event")
      assertAuditAction(auditEvents, "prune", "scenario revision-lifecycle missing prune audit event")

      const turnOneToolEvents = collectToolEvents(input.parsedResponses[0])
      const reviewPendingEvent = turnOneToolEvents.find((event) => event.tool === "evolver_review_pending")
      const pendingReview = parseToolOutput(reviewPendingEvent?.output) as {
        currentRevisionID?: string | null
        pendingRevisionID?: string | null
        changedArtifacts?: { commands?: string[] }
      }
      const pendingReviewArtifact = JSON.parse(
        await readFile(join(input.workspaceRoot, ".opencode/oc-evolver/pending-review.json"), "utf8"),
      ) as {
        currentRevisionID?: string | null
        pendingRevisionID?: string | null
        changedArtifacts?: { commands?: string[] }
      }
      const pendingSnapshotEvidence = JSON.parse(
        await readFile(join(input.workspaceRoot, ".opencode/oc-evolver/pending-review-snapshot.json"), "utf8"),
      ) as {
        pendingRevisionID?: string | null
        snapshotPath?: string | null
      }
      if (
        typeof pendingReview.currentRevisionID !== "string" ||
        pendingReview.currentRevisionID.length === 0 ||
        typeof pendingReview.pendingRevisionID !== "string" ||
        pendingReview.pendingRevisionID.length === 0 ||
        pendingReview.currentRevisionID === pendingReview.pendingRevisionID
      ) {
        throw new Error("scenario revision-lifecycle missing durable pending revision review evidence")
      }

      if (!pendingReview.changedArtifacts?.commands?.includes("review-markdown")) {
        throw new Error("scenario revision-lifecycle pending review did not report the deleted command")
      }

      if (
        pendingSnapshotEvidence.pendingRevisionID !== pendingReview.pendingRevisionID ||
        pendingSnapshotEvidence.snapshotPath !==
          `.opencode/oc-evolver/revisions/${pendingReview.pendingRevisionID}.json`
      ) {
        throw new Error("scenario revision-lifecycle missing durable evidence that the pending snapshot existed before prune")
      }

      if (
        pendingReviewArtifact.currentRevisionID !== pendingReview.currentRevisionID ||
        pendingReviewArtifact.pendingRevisionID !== pendingReview.pendingRevisionID ||
        !pendingReviewArtifact.changedArtifacts?.commands?.includes("review-markdown")
      ) {
        throw new Error("scenario revision-lifecycle pending-review artifact did not match the reviewed output")
      }

      if (registry.pendingRevision !== null) {
        throw new Error("scenario revision-lifecycle left a pending revision behind")
      }

      if (!registry.commands?.["review-markdown"]) {
        throw new Error("scenario revision-lifecycle failed to restore the accepted command entry")
      }

      const commandDocument = await readFile(
        join(input.workspaceRoot, ".opencode/commands/review-markdown.md"),
        "utf8",
      )

      if (commandDocument.trim().length === 0) {
        throw new Error("scenario revision-lifecycle did not restore a non-empty accepted command body")
      }

      if (typeof registry.currentRevision !== "string" || registry.currentRevision.length === 0) {
        throw new Error("scenario revision-lifecycle missing the restored accepted revision id")
      }

      await readFile(
        join(
          input.workspaceRoot,
          ".opencode/oc-evolver/revisions",
          `${registry.currentRevision}.json`,
        ),
        "utf8",
      )

      try {
        await readFile(
          join(
            input.workspaceRoot,
            ".opencode/oc-evolver/revisions",
            `${pendingReview.pendingRevisionID}.json`,
          ),
          "utf8",
        )
        throw new Error("scenario revision-lifecycle did not prune the obsolete revision snapshot")
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error
        }
      }

      return
    }
    case "rollback": {
      const promoteEvents = auditEvents.filter(
        (event) => event.action === "promote" && event.status === "success",
      )

      if (promoteEvents.length < 2) {
        throw new Error("scenario rollback missing promote audit events for accepted revisions")
      }

      assertAuditAction(auditEvents, "rollback", "scenario rollback missing rollback audit event")
      const commandDocument = await readFile(
        join(input.workspaceRoot, ".opencode/commands/review-markdown.md"),
        "utf8",
      )

      if (
        !commandDocument.includes("First review flow") ||
        !commandDocument.includes("Review README.md once.")
      ) {
        throw new Error("scenario rollback did not restore the first command body")
      }

      const rollbackEvent = auditEvents.find((event) => event.action === "rollback" && event.status === "success")

      if (!rollbackEvent?.revisionID) {
        throw new Error("scenario rollback missing restored revision id in audit")
      }

      if (registry.currentRevision !== rollbackEvent.revisionID) {
        throw new Error("scenario rollback registry currentRevision did not point at the restored revision")
      }

      if (registry.pendingRevision !== null) {
        throw new Error("scenario rollback left a pending revision behind")
      }

      return
    }
    case "autonomous-control": {
      if (input.turns.length !== 2) {
        throw new Error(`scenario autonomous-control expected exactly 2 turns, got ${input.turns.length}`)
      }

      const turnOneToolSequence = collectExecutedToolSequence(input.parsedResponses[0])
      const turnTwoToolSequence = collectExecutedToolSequence(input.parsedResponses[1])
      const turnOneToolEvents = collectToolEvents(input.parsedResponses[0])
      const turnTwoToolEvents = collectToolEvents(input.parsedResponses[1])

      assertAuditAction(auditEvents, "autonomous_pause", "scenario autonomous-control missing autonomous_pause audit event")
      assertAuditAction(auditEvents, "autonomous_resume", "scenario autonomous-control missing autonomous_resume audit event")

      assertExactToolSequence(
        turnOneToolSequence,
        AUTONOMOUS_CONTROL_TURN_ONE_TOOLS,
        "scenario autonomous-control did not follow the required turn-1 configure/pause path",
      )

      assertExactToolSequence(
        turnTwoToolSequence,
        AUTONOMOUS_CONTROL_TURN_TWO_TOOLS,
        "scenario autonomous-control did not follow the required turn-2 resume/status path",
      )

      const configureEvent = turnOneToolEvents.find((event) => event.tool === "evolver_autonomous_configure")

      if (!configureEvent?.input) {
        throw new Error("scenario autonomous-control did not expose the required configure payload")
      }

      if (!areJsonValuesEqual(configureEvent.input, AUTONOMOUS_CONTROL_CONFIGURE_INPUT)) {
        throw new Error("scenario autonomous-control did not use the required configure payload")
      }

      const pauseEvent = turnOneToolEvents.find((event) => event.tool === "evolver_autonomous_pause")
      const pausedSnapshot = parseToolOutput(pauseEvent?.output) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
        }
      }
      const pausedArtifact = JSON.parse(
        await readFile(join(input.workspaceRoot, ".opencode/oc-evolver/autonomous-loop-paused.json"), "utf8"),
      ) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
        }
      }

      if (
        pausedSnapshot.config?.enabled !== true ||
        pausedSnapshot.config?.paused !== true ||
        pausedSnapshot.config?.intervalMs !== 60_000
      ) {
        throw new Error("scenario autonomous-control missing durable paused-state evidence after turn 1")
      }

      if (
        pausedArtifact.config?.enabled !== pausedSnapshot.config?.enabled ||
        pausedArtifact.config?.paused !== pausedSnapshot.config?.paused ||
        pausedArtifact.config?.intervalMs !== pausedSnapshot.config?.intervalMs
      ) {
        throw new Error("scenario autonomous-control paused-state artifact did not match the pause output")
      }

      const resumeEvent = turnTwoToolEvents.find((event) => event.tool === "evolver_autonomous_resume")
      const statusEvent = turnTwoToolEvents.find((event) => event.tool === "evolver_autonomous_status")
      const resumedState = parseToolOutput(resumeEvent?.output) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
        }
        activation?: {
          mode?: string
        }
      }

      if (
        resumedState.config?.enabled !== true ||
        resumedState.config?.paused !== false ||
        resumedState.config?.intervalMs !== 60_000 ||
        resumedState.activation?.mode !== "worker"
      ) {
        throw new Error("scenario autonomous-control resume output did not reflect the resumed worker state")
      }

      const statusState = parseToolOutput(statusEvent?.output) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
          verificationCommands?: string[][]
          evaluationScenarios?: string[]
        }
      }

      if (
        statusState.config?.enabled !== true ||
        statusState.config?.paused !== false ||
        statusState.config?.intervalMs !== 60_000 ||
        JSON.stringify(statusState.config?.verificationCommands ?? []) !==
          JSON.stringify([["bun", "run", "typecheck"]]) ||
        JSON.stringify(statusState.config?.evaluationScenarios ?? []) !==
          JSON.stringify(["autonomous-run"])
      ) {
        throw new Error("scenario autonomous-control status output did not reflect the resumed configured state")
      }

      const loopState = JSON.parse(
        await readFile(join(input.workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"), "utf8"),
      ) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
          verificationCommands?: string[][]
          evaluationScenarios?: string[]
          failurePolicy?: {
            maxConsecutiveFailures?: number
            escalationAction?: string
          }
        }
        iterations?: unknown[]
      }

      if (loopState.config?.enabled !== true || loopState.config?.paused !== false) {
        throw new Error("scenario autonomous-control did not end in the resumed enabled state")
      }

      if (loopState.config?.intervalMs !== 60_000) {
        throw new Error("scenario autonomous-control did not persist intervalMs: 60000")
      }

      if (
        JSON.stringify(loopState.config?.verificationCommands ?? []) !==
          JSON.stringify([["bun", "run", "typecheck"]]) ||
        JSON.stringify(loopState.config?.evaluationScenarios ?? []) !==
          JSON.stringify(["autonomous-run"])
      ) {
        throw new Error("scenario autonomous-control did not persist the configured verification/evaluation settings")
      }

      if (
        loopState.config?.failurePolicy?.maxConsecutiveFailures !== 3 ||
        loopState.config?.failurePolicy?.escalationAction !== "pause_loop"
      ) {
        throw new Error("scenario autonomous-control did not persist the required failurePolicy")
      }

      if ((loopState.iterations ?? []).length !== 0) {
        throw new Error("scenario autonomous-control unexpectedly recorded loop iterations")
      }

      return
    }
    case "autonomous-run": {
      if (input.turns.length !== 2) {
        throw new Error(`scenario autonomous-run expected exactly 2 turns, got ${input.turns.length}`)
      }

      assertAuditAction(auditEvents, "promote", "scenario autonomous-run missing promote audit event")

      if (!input.changedFiles.includes(".opencode/oc-evolver/autonomous-loop.json")) {
        throw new Error("scenario autonomous-run missing persisted autonomous loop state")
      }

      if (registry.currentRevision === null || registry.currentRevision === undefined) {
        throw new Error("scenario autonomous-run did not leave an accepted revision")
      }

      const loopState = JSON.parse(
        await readFile(join(input.workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"), "utf8"),
      ) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
          verificationCommands?: string[][]
          evaluationScenarios?: string[]
          failurePolicy?: {
            maxConsecutiveFailures?: number
            escalationAction?: string
          }
        }
        latestLearning?: { summary?: string } | null
        objectives?: Array<{
          prompt?: string
          status?: string
          completionCriteria?: {
            changedArtifacts?: string[]
            evaluationScenarios?: string[]
            verificationCommands?: string[][]
          } | null
          lastCompletionEvidence?: {
            satisfied?: boolean
            changedArtifacts?: string[]
            passedEvaluationScenarios?: string[]
            passedVerificationCommands?: string[][]
          } | null
        }>
        iterations?: Array<{
          decision?: string
          changedArtifacts?: string[]
          evaluations?: Array<{
            scenarioName?: string
            exitCode?: number
          }>
          verification?: Array<{
            command?: string[]
            exitCode?: number
          }>
        }>
      }

      const latestIteration = loopState.iterations?.at(-1)

      if (latestIteration?.decision !== "promoted") {
        throw new Error("scenario autonomous-run latest iteration was not promoted")
      }

      if (!loopState.latestLearning?.summary?.includes("promoted")) {
        throw new Error("scenario autonomous-run missing promoted learning summary")
      }

      const objective = loopState.objectives?.[0]
      const turnOneToolSequence = collectExecutedToolSequence(input.parsedResponses[0])
      const turnTwoToolSequence = collectExecutedToolSequence(input.parsedResponses[1])
      const turnOneToolEvents = collectToolEvents(input.parsedResponses[0])
      const turnTwoToolEvents = collectToolEvents(input.parsedResponses[1])
      const turnOneTools = new Set(turnOneToolSequence)
      const turnTwoTools = new Set(turnTwoToolSequence)

      assertExactToolSequence(
        turnOneToolSequence,
        AUTONOMOUS_RUN_TURN_ONE_TOOLS,
        "scenario autonomous-run did not follow the required turn-1 configure/start path",
      )

      if (turnOneTools.has("evolver_autonomous_run") || turnTwoTools.has("evolver_autonomous_run")) {
        throw new Error("scenario autonomous-run used evolver_autonomous_run instead of the required start path")
      }

      const configureEvent = turnOneToolEvents.find((event) => event.tool === "evolver_autonomous_configure")

      if (!configureEvent?.input) {
        throw new Error("scenario autonomous-run did not expose the required configure payload")
      }

      if (!areJsonValuesEqual(configureEvent.input, AUTONOMOUS_RUN_CONFIGURE_INPUT)) {
        throw new Error("scenario autonomous-run did not use the required configure payload")
      }

      assertNoExecutedTools(
        turnOneTools,
        OUTER_AUTONOMOUS_MUTATING_TOOLS,
        "scenario autonomous-run executed an unexpected outer-session mutating tool",
      )

      assertExactToolSequence(
        turnTwoToolSequence,
        AUTONOMOUS_RUN_TURN_TWO_TOOLS,
        "scenario autonomous-run did not prove the required turn-2 status-only path",
      )

      assertNoExecutedTools(
        turnTwoTools,
        OUTER_AUTONOMOUS_MUTATING_TOOLS,
        "scenario autonomous-run executed an unexpected outer-session mutating tool",
      )

      const statusEvent = turnTwoToolEvents.find((event) => event.tool === "evolver_autonomous_status")
      const statusState = parseToolOutput(statusEvent?.output) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
          verificationCommands?: string[][]
          evaluationScenarios?: string[]
        }
        objectives?: Array<{
          prompt?: string
          status?: string
          completionCriteria?: {
            changedArtifacts?: string[]
            evaluationScenarios?: string[]
            verificationCommands?: string[][]
          } | null
          lastCompletionEvidence?: {
            satisfied?: boolean
            changedArtifacts?: string[]
            passedEvaluationScenarios?: string[]
            passedVerificationCommands?: string[][]
          } | null
        }>
      }
      const statusObjective = statusState.objectives?.[0]
      const registryStatusEvent = turnTwoToolEvents.find((event) => event.tool === "evolver_status")
      const registryStatus = parseToolOutput(registryStatusEvent?.output) as {
        memories?: Record<string, { revisionID?: string }>
        currentRevision?: string | null
        pendingRevision?: string | null
      }

      if (
        statusState.config?.enabled !== true ||
        statusState.config?.paused !== false ||
        statusState.config?.intervalMs !== 0 ||
        JSON.stringify(statusState.config?.verificationCommands ?? []) !== JSON.stringify([]) ||
        JSON.stringify(statusState.config?.evaluationScenarios ?? []) !== JSON.stringify(["smoke"]) ||
        statusObjective?.prompt !== AUTONOMOUS_RUN_OBJECTIVE_PROMPT ||
        statusObjective?.status !== "completed" ||
        statusObjective.lastCompletionEvidence?.satisfied !== true ||
        !statusObjective.lastCompletionEvidence?.changedArtifacts?.includes("memory:autonomous-evidence-memory") ||
        !statusObjective.lastCompletionEvidence?.passedEvaluationScenarios?.includes("smoke") ||
        !statusObjective.lastCompletionEvidence?.passedEvaluationScenarios?.includes("objective-memory-evidence") ||
        !statusObjective.lastCompletionEvidence?.passedVerificationCommands?.some((command) =>
          areJsonValuesEqual(command, AUTONOMOUS_RUN_OBJECTIVE_VERIFICATION_COMMAND),
        )
      ) {
        throw new Error("scenario autonomous-run status output did not reflect the completed objective state")
      }

      if (
        registryStatus.currentRevision !== registry.currentRevision ||
        registryStatus.pendingRevision !== registry.pendingRevision ||
        !registryStatus.memories?.["autonomous-evidence-memory"] ||
        registryStatus.memories["autonomous-evidence-memory"].revisionID !== registry.currentRevision
      ) {
        throw new Error("scenario autonomous-run evolver_status output did not reflect the promoted registry state")
      }

      if (!objective || objective.status !== "completed") {
        throw new Error("scenario autonomous-run did not complete the queued objective")
      }

      if (loopState.config?.enabled !== true || loopState.config?.paused !== false) {
        throw new Error("scenario autonomous-run did not persist the required enabled/paused configuration")
      }

      if (loopState.config?.intervalMs !== 0) {
        throw new Error("scenario autonomous-run did not persist intervalMs: 0")
      }

      if ((loopState.config?.verificationCommands ?? []).length !== 0) {
        throw new Error("scenario autonomous-run did not persist verificationCommands: []")
      }

      if (
        JSON.stringify(loopState.config?.evaluationScenarios ?? []) !==
        JSON.stringify(["smoke"])
      ) {
        throw new Error("scenario autonomous-run did not persist evaluationScenarios: [\"smoke\"]")
      }

      if (
        loopState.config?.failurePolicy?.maxConsecutiveFailures !== 3 ||
        loopState.config?.failurePolicy?.escalationAction !== "pause_loop"
      ) {
        throw new Error("scenario autonomous-run did not persist the required failurePolicy")
      }

      if (objective.prompt !== AUTONOMOUS_RUN_OBJECTIVE_PROMPT) {
        throw new Error("scenario autonomous-run did not persist the required queued objective prompt")
      }

      if (
        JSON.stringify(objective.completionCriteria?.changedArtifacts ?? []) !==
          JSON.stringify(AUTONOMOUS_RUN_COMPLETION_CRITERIA.changedArtifacts) ||
        JSON.stringify(objective.completionCriteria?.evaluationScenarios ?? []) !==
          JSON.stringify(AUTONOMOUS_RUN_COMPLETION_CRITERIA.evaluationScenarios) ||
        JSON.stringify(objective.completionCriteria?.verificationCommands ?? []) !==
          JSON.stringify(AUTONOMOUS_RUN_COMPLETION_CRITERIA.verificationCommands)
      ) {
        throw new Error("scenario autonomous-run did not persist the required queued objective completion criteria")
      }

      const completionEvidence = objective.lastCompletionEvidence

      if (!completionEvidence?.satisfied) {
        throw new Error("scenario autonomous-run missing satisfied completion evidence")
      }

      const requiredChangedArtifacts = objective.completionCriteria?.changedArtifacts ?? []
      const requiredEvaluationScenarios = [
        ...(loopState.config?.evaluationScenarios ?? []),
        ...(objective.completionCriteria?.evaluationScenarios ?? []),
      ]
      const requiredVerificationCommands = objective.completionCriteria?.verificationCommands ?? []

      for (const artifact of requiredChangedArtifacts) {
        if (!completionEvidence.changedArtifacts?.includes(artifact)) {
          throw new Error(
            `scenario autonomous-run completion evidence missing required changed artifact: ${artifact}`,
          )
        }

        if (!latestIteration.changedArtifacts?.includes(artifact)) {
          throw new Error(
            `scenario autonomous-run latest iteration missing required changed artifact: ${artifact}`,
          )
        }

        if (!registryHasArtifact(registry, artifact)) {
          throw new Error(`scenario autonomous-run registry missing required artifact: ${artifact}`)
        }
      }

      for (const scenarioName of requiredEvaluationScenarios) {
        if (!completionEvidence.passedEvaluationScenarios?.includes(scenarioName)) {
          throw new Error(
            `scenario autonomous-run completion evidence missing required evaluation scenario: ${scenarioName}`,
          )
        }

        if (
          !latestIteration.evaluations?.some(
            (evaluation) => evaluation.scenarioName === scenarioName && evaluation.exitCode === 0,
          )
        ) {
          throw new Error(
            `scenario autonomous-run latest iteration missing passing evaluation scenario: ${scenarioName}`,
          )
        }
      }

      for (const command of requiredVerificationCommands) {
        if (
          !completionEvidence.passedVerificationCommands?.some((passedCommand) =>
            areJsonValuesEqual(passedCommand, command),
          )
        ) {
          throw new Error(
            `scenario autonomous-run completion evidence missing required verification command: ${JSON.stringify(command)}`,
          )
        }

        if (
          !latestIteration.verification?.some(
            (record) => record.exitCode === 0 && areJsonValuesEqual(record.command, command),
          )
        ) {
          throw new Error(
            `scenario autonomous-run latest iteration missing passing verification command: ${JSON.stringify(command)}`,
          )
        }
      }

      return
    }
    case "autonomous-startup": {
      if (input.turns.length !== 1) {
        throw new Error(`scenario autonomous-startup expected exactly 1 turn, got ${input.turns.length}`)
      }

      assertAuditAction(
        auditEvents,
        "autonomous_restore",
        "scenario autonomous-startup missing autonomous_restore audit event",
      )

      if (!input.changedFiles.includes(".opencode/oc-evolver/audit.ndjson")) {
        throw new Error("scenario autonomous-startup missing persisted audit log")
      }

      const loopState = JSON.parse(
        await readFile(join(input.workspaceRoot, ".opencode/oc-evolver/autonomous-loop.json"), "utf8"),
      ) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
          verificationCommands?: string[][]
          evaluationScenarios?: string[]
        }
        iterations?: unknown[]
      }

      const turnOneToolSequence = collectExecutedToolSequence(input.parsedResponses[0])
      const turnOneToolEvents = collectToolEvents(input.parsedResponses[0])

      assertExactToolSequence(
        turnOneToolSequence,
        AUTONOMOUS_STARTUP_TURN_ONE_TOOLS,
        "scenario autonomous-startup did not prove the required status-only inspection path",
      )

      assertNoExecutedTools(
        new Set(turnOneToolSequence),
        OUTER_AUTONOMOUS_MUTATING_TOOLS,
        "scenario autonomous-startup executed an unexpected outer-session mutating tool",
      )

      const statusEvent = turnOneToolEvents.find((event) => event.tool === "evolver_autonomous_status")
      const statusState = parseToolOutput(statusEvent?.output) as {
        config?: {
          enabled?: boolean
          paused?: boolean
          intervalMs?: number
          verificationCommands?: string[][]
          evaluationScenarios?: string[]
        }
      }
      const registryStatusEvent = turnOneToolEvents.find((event) => event.tool === "evolver_status")
      const registryStatus = parseToolOutput(registryStatusEvent?.output) as {
        currentRevision?: string | null
        pendingRevision?: string | null
      }

      if (
        statusState.config?.enabled !== true ||
        statusState.config?.paused !== false ||
        statusState.config?.intervalMs !== 60_000 ||
        JSON.stringify(statusState.config?.verificationCommands ?? []) !==
          JSON.stringify([["bun", "run", "typecheck"]]) ||
        JSON.stringify(statusState.config?.evaluationScenarios ?? []) !==
          JSON.stringify(["autonomous-run"])
      ) {
        throw new Error("scenario autonomous-startup status output did not reflect the restored scheduled state")
      }

      if (
        registryStatus.currentRevision !== registry.currentRevision ||
        registryStatus.pendingRevision !== registry.pendingRevision
      ) {
        throw new Error("scenario autonomous-startup evolver_status output did not reflect the restored registry state")
      }

      if (loopState.config?.enabled !== true || loopState.config?.paused !== false) {
        throw new Error("scenario autonomous-startup did not restore the enabled scheduled state")
      }

      if (loopState.config?.intervalMs !== 60_000) {
        throw new Error("scenario autonomous-startup did not preserve intervalMs: 60000")
      }

      if (
        JSON.stringify(loopState.config?.verificationCommands ?? []) !==
          JSON.stringify([["bun", "run", "typecheck"]]) ||
        JSON.stringify(loopState.config?.evaluationScenarios ?? []) !==
          JSON.stringify(["autonomous-run"])
      ) {
        throw new Error(
          "scenario autonomous-startup did not preserve the configured verification/evaluation settings",
        )
      }

      if ((loopState.iterations ?? []).length !== 0) {
        throw new Error("scenario autonomous-startup unexpectedly recorded loop iterations")
      }

      return
    }
    default:
      return
  }
}

function registryHasArtifact(
  registry: {
    skills?: Record<string, unknown>
    agents?: Record<string, unknown>
    commands?: Record<string, unknown>
    memories?: Record<string, unknown>
  },
  artifact: string,
) {
  const separatorIndex = artifact.indexOf(":")

  if (separatorIndex === -1) {
    return false
  }

  const kind = artifact.slice(0, separatorIndex)
  const name = artifact.slice(separatorIndex + 1)

  switch (kind) {
    case "skill":
      return Boolean(registry.skills?.[name])
    case "agent":
      return Boolean(registry.agents?.[name])
    case "command":
      return Boolean(registry.commands?.[name])
    case "memory":
      return Boolean(registry.memories?.[name])
    default:
      return false
  }
}

function collectExecutedToolSequence(parsedResponse: ParsedEvalResponse | undefined) {
  const toolSequence: string[] = []

  walkParsedResponse(parsedResponse, undefined, toolSequence)

  return toolSequence
}

function collectToolEvents(parsedResponse: ParsedEvalResponse | undefined) {
  const toolEvents: Array<{ tool: string; input?: unknown; output?: unknown }> = []

  walkParsedResponse(parsedResponse, undefined, undefined, toolEvents)

  return toolEvents
}

function assertNoExecutedTools(toolNames: Set<string>, disallowedTools: Set<string>, message: string) {
  const executedDisallowedTools = [...toolNames].filter((toolName) => disallowedTools.has(toolName))

  if (executedDisallowedTools.length > 0) {
    throw new Error(`${message}: ${executedDisallowedTools.join(", ")}`)
  }
}

function assertExactToolSequence(actual: string[], expected: readonly string[], message: string) {
  if (actual.length !== expected.length || actual.some((toolName, index) => toolName !== expected[index])) {
    throw new Error(`${message}: expected ${expected.join(" -> ")}, got ${actual.join(" -> ") || "(none)"}`)
  }
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }

    return left.every((value, index) => areJsonValuesEqual(value, right[index]))
  }

  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))

    if (leftEntries.length !== rightEntries.length) {
      return false
    }

    return leftEntries.every(([leftKey, leftValue], index) => {
      const [rightKey, rightValue] = rightEntries[index] ?? []

      return leftKey === rightKey && areJsonValuesEqual(leftValue, rightValue)
    })
  }

  return Object.is(left, right)
}

function parseToolOutput(output: unknown) {
  if (typeof output !== "string") {
    return output ?? null
  }

  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function readObjectStringField(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const fieldValue = (value as Record<string, unknown>)[key]

  return typeof fieldValue === "string" ? fieldValue : null
}

function parseFrontmatter(document: string) {
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)

  if (!match) {
    return {}
  }

  try {
    const parsed = Bun.YAML.parse(match[1] ?? "")
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function walkParsedResponse(
  value: unknown,
  toolNames?: Set<string>,
  toolSequence?: string[],
  toolEvents?: Array<{ tool: string; input?: unknown; output?: unknown }>,
) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkParsedResponse(entry, toolNames, toolSequence, toolEvents)
    }

    return
  }

  if (!value || typeof value !== "object") {
    return
  }

  if ("tool" in value && typeof value.tool === "string") {
    toolNames?.add(value.tool)
    toolSequence?.push(value.tool)
    const input =
      "state" in value &&
      value.state &&
      typeof value.state === "object" &&
      "input" in value.state
        ? value.state.input
        : "input" in value
          ? value.input
          : undefined
    const output =
      "state" in value &&
      value.state &&
      typeof value.state === "object" &&
      "output" in value.state
        ? value.state.output
        : "output" in value
          ? value.output
          : undefined
    toolEvents?.push({
      tool: value.tool,
      input,
      output,
    })
  }

  for (const nestedValue of Object.values(value)) {
    walkParsedResponse(nestedValue, toolNames, toolSequence, toolEvents)
  }
}

async function readAuditEvents(workspaceRoot: string) {
  try {
    const auditLog = await readFile(join(workspaceRoot, ".opencode/oc-evolver/audit.ndjson"), "utf8")

    return auditLog
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { action?: string; status?: string; revisionID?: string })
  } catch {
    return []
  }
}

async function readRegistry(workspaceRoot: string) {
  return JSON.parse(
    await readFile(join(workspaceRoot, ".opencode/oc-evolver/registry.json"), "utf8"),
  ) as {
    skills?: Record<string, { helperPaths?: string[] }>
    commands?: Record<string, unknown>
    memories?: Record<string, unknown>
    currentRevision?: string | null
    pendingRevision?: string | null
  }
}

function assertAuditAction(
  auditEvents: Array<{ action?: string; status?: string; revisionID?: string }>,
  action: string,
  message: string,
  expectedStatus = "success",
) {
  if (!auditEvents.some((event) => event.action === action && event.status === expectedStatus)) {
    throw new Error(message)
  }
}
async function assertProtectedPluginFileUnchanged(baseFixtureRoot: string, workspaceRoot: string) {
  const protectedRelativePath = ".opencode/plugins/oc-evolver.ts"
  const basePluginPath = join(baseFixtureRoot, protectedRelativePath)
  const workspacePluginPath = join(workspaceRoot, protectedRelativePath)

  const [basePlugin, workspacePlugin] = await Promise.all([
    readFile(basePluginPath, "utf8"),
    readFile(workspacePluginPath, "utf8"),
  ])

  if (basePlugin !== workspacePlugin) {
    throw new Error("protected plugin file changed during evaluation")
  }
}

function shouldIgnoreChangedFile(relativePath: string) {
  if (IGNORED_CHANGED_FILES.has(relativePath)) {
    return true
  }

  return IGNORED_CHANGED_FILE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
}

async function walkDirectory(
  rootPath: string,
  currentPath: string,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = join(currentPath, entry.name)
    const entryRelativePath = relative(rootPath, entryPath).replaceAll("\\", "/")

    if (shouldSkipWalkPath(entryRelativePath, entry.isDirectory())) {
      continue
    }

    if (entry.isDirectory()) {
      await walkDirectory(rootPath, entryPath, onFile)
      continue
    }

    if (entry.isFile()) {
      await onFile(entryPath)
      continue
    }

    const entryStats = await stat(entryPath)

    if (entryStats.isDirectory()) {
      if (!shouldSkipWalkPath(entryRelativePath, true)) {
        await walkDirectory(rootPath, entryPath, onFile)
      }
    }

    if (entryStats.isFile()) {
      await onFile(entryPath)
    }
  }
}

function shouldSkipWalkPath(relativePath: string, isDirectory: boolean) {
  if (IGNORED_CHANGED_FILES.has(relativePath)) {
    return true
  }

  return IGNORED_CHANGED_FILE_PREFIXES.some((prefix) => {
    const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix

    return relativePath === normalizedPrefix || relativePath.startsWith(prefix)
  })
}

async function main() {
  const scenarioArg = process.argv[2]

  if (!scenarioArg) {
    throw new Error("usage: bun run scripts/run-eval.ts <scenario|all>")
  }

  const normalizedRepoRoot = fileURLToPath(new URL("..", import.meta.url))
  const scenarios = scenarioArg === "all" ? DEFAULT_SCENARIOS : [scenarioArg]

  let failed = false

  for (const scenarioName of scenarios) {
    const result = await runEvaluationScenario({
      repoRoot: normalizedRepoRoot,
      scenarioName,
    })

    if (result.exitCode !== 0) {
      failed = true
    }
  }

  if (failed) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main()
}
