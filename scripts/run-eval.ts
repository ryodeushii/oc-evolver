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

const DEFAULT_SCENARIOS = [
  "smoke",
  "create-skill",
  "create-agent",
  "reuse-skill",
  "policy-deny",
  "invalid-artifact",
  "memory-guided-write",
  "artifact-only-deny",
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
  const parsedResponses: unknown[] = []
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

    if (Array.isArray(parsedResponse)) {
      parsedResponses.push(...parsedResponse)
    } else {
      parsedResponses.push(parsedResponse)
    }

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
  if (scenarioName !== "invalid-artifact") {
    return
  }

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
}

async function assertScenarioArtifacts(input: {
  scenarioName: string
  workspaceRoot: string
  changedFiles: string[]
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
    case "rollback": {
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

      return
    }
    default:
      return
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
    memories?: Record<string, unknown>
    currentRevision?: string | null
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

  const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..")
  const normalizedRepoRoot = repoRoot.startsWith("/") ? repoRoot : `/${repoRoot}`
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
