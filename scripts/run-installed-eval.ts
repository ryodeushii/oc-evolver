import { spawn } from "node:child_process"
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import runtimeContract from "../eval/runtime-contract.json"

type EvalCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type EvaluationTurn = {
  turnNumber: number
  prompt: string
  command: string[]
  exitCode: number
  sessionID: string | null
}

type ParsedEvalResponse = unknown[] | { raw: string }

type InstalledEvaluationResult = {
  scenarioName: string
  resultDir: string
  workspaceRoot: string
  globalOpencodeRoot: string
  stdout: string
  stderr: string
  exitCode: number
}

const INSTALLED_SCENARIOS = new Set(["smoke", "policy-deny", "autonomous-run"])
const INSTALLED_AUTONOMOUS_COMPLETION_CRITERIA = {
  changedArtifacts: ["memory:autonomous-evidence-memory"],
  evaluationScenarios: ["objective-memory-evidence"],
  verificationCommands: [["bun", "--version"]],
} as const
const INSTALLED_AUTONOMOUS_OBJECTIVE_PROMPT =
  'Make exactly one mutation by calling evolver_write_memory with memoryName "autonomous-evidence-memory" and document "---\nname: autonomous-evidence-memory\ndescription: Autonomous evaluation evidence memory.\n---\n\nAutonomous evaluation evidence memory.". After the write succeeds, respond with exactly one short confirmation sentence. Do not call evolver_autonomous_run. Do not call status tools before the write.'
const INSTALLED_AUTONOMOUS_PROMPT = `Turn 1:

Continue the same session.

Use these exact tool calls in order.

1. Call \`evolver_autonomous_start\`.

Do not call any other tools in turn 1.

Exit successfully after the start call completes.

---

Turn 2:

Continue the same session.

Use these exact tool calls in order.

1. Call \`evolver_autonomous_status\`.

Do not call any other tools in turn 2.

Exit successfully after the autonomous status read completes.

---

Turn 3:

Continue the same session.

Use these exact tool calls in order.

1. Call \`evolver_status\`.

Do not call any other tools in turn 3.

Exit successfully after the registry status read completes.`

function parseScenarioPrompts(prompt: string) {
  return prompt
    .split(/^---$/m)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function parseOpencodeJsonStream(stdout: string): ParsedEvalResponse {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const parsed: unknown[] = []

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      return { raw: stdout }
    }
  }

  return parsed
}

function extractSessionID(parsedResponse: ParsedEvalResponse) {
  if (!Array.isArray(parsedResponse)) {
    return null
  }

  for (const event of parsedResponse) {
    if (!event || typeof event !== "object") {
      continue
    }

    const sessionID = (event as { sessionID?: unknown }).sessionID

    if (typeof sessionID === "string" && sessionID.length > 0) {
      return sessionID
    }
  }

  return null
}

function collectExecutedToolSequence(parsedResponse: ParsedEvalResponse) {
  if (!Array.isArray(parsedResponse)) {
    return []
  }

  const toolSequence: string[] = []

  for (const event of parsedResponse) {
    if (!event || typeof event !== "object") {
      continue
    }

    const part = (event as { part?: unknown }).part

    if (!part || typeof part !== "object") {
      continue
    }

    const toolName = (part as { tool?: unknown }).tool

    if (typeof toolName === "string" && toolName.length > 0) {
      toolSequence.push(toolName)
    }
  }

  return toolSequence
}

function assertExactToolSequence(actual: string[], expected: readonly string[], message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)} but found ${JSON.stringify(actual)}`)
  }
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return fallback
  }
}

async function readAuditEvents(auditPath: string) {
  try {
    return (await readFile(auditPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { action?: string; status?: string; target?: string })
  } catch {
    return [] as Array<{ action?: string; status?: string; target?: string }>
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
  command: string[]
  env: NodeJS.ProcessEnv
  opencodeExecutable: string
}): Promise<EvalCommandResult> {
  const [, ...args] = input.command

  return await new Promise((resolve, reject) => {
    const child = spawn(input.opencodeExecutable, args, {
      cwd: input.workspaceRoot,
      env: input.env,
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

function resolveInstalledRoots(globalOpencodeRoot: string) {
  return {
    registryRoot: join(globalOpencodeRoot, basename(runtimeContract.registryDir)),
    skillsRoot: join(globalOpencodeRoot, basename(runtimeContract.skillDir)),
    agentsRoot: join(globalOpencodeRoot, basename(runtimeContract.nativeAgentDir)),
    commandsRoot: join(globalOpencodeRoot, basename(runtimeContract.commandDir)),
    memoriesRoot: join(globalOpencodeRoot, basename(runtimeContract.memoryDir)),
  }
}

async function seedInstalledAutonomousRunState(globalOpencodeRoot: string) {
  const installedRoots = resolveInstalledRoots(globalOpencodeRoot)

  await Promise.all([
    mkdir(installedRoots.registryRoot, { recursive: true }),
    mkdir(installedRoots.skillsRoot, { recursive: true }),
    mkdir(installedRoots.agentsRoot, { recursive: true }),
    mkdir(installedRoots.commandsRoot, { recursive: true }),
    mkdir(installedRoots.memoriesRoot, { recursive: true }),
  ])

  await writeFile(
    join(installedRoots.registryRoot, "registry.json"),
    `${JSON.stringify(
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
    )}\n`,
  )
  await writeFile(join(installedRoots.registryRoot, "audit.ndjson"), "")
  await writeFile(
    join(installedRoots.registryRoot, "autonomous-loop.json"),
    `${JSON.stringify(
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
        lastSessionID: null,
        latestLearning: null,
        objectives: [
          {
            prompt: INSTALLED_AUTONOMOUS_OBJECTIVE_PROMPT,
            priority: 0,
            status: "pending",
            source: "manual",
            rationale: null,
            completionCriteria: INSTALLED_AUTONOMOUS_COMPLETION_CRITERIA,
            attempts: 0,
            consecutiveFailures: 0,
            updatedAt: new Date(0).toISOString(),
            lastSessionID: null,
            lastDecision: null,
            lastEscalationReason: null,
          },
        ],
        iterations: [],
      },
      null,
      2,
    )}\n`,
  )
}

async function ensurePathMissing(path: string) {
  await expectPathAccess(path, false)
}

async function expectPathAccess(path: string, shouldExist: boolean) {
  try {
    await access(path)

    if (!shouldExist) {
      throw new Error(`expected path to be absent: ${path}`)
    }
  } catch (error) {
    if (shouldExist) {
      throw error
    }
  }
}

async function assertInstalledRootLayout(input: {
  workspaceRoot: string
  globalOpencodeRoot: string
}) {
  const installedRoots = resolveInstalledRoots(input.globalOpencodeRoot)

  await expectPathAccess(installedRoots.registryRoot, true)
  await expectPathAccess(installedRoots.skillsRoot, true)
  await expectPathAccess(installedRoots.agentsRoot, true)
  await expectPathAccess(installedRoots.commandsRoot, true)
  await expectPathAccess(installedRoots.memoriesRoot, true)

  await ensurePathMissing(join(input.workspaceRoot, runtimeContract.registryDir))
  await ensurePathMissing(join(input.workspaceRoot, runtimeContract.skillDir))
  await ensurePathMissing(join(input.workspaceRoot, `.opencode/${runtimeContract.nativeAgentDir}`))
  await ensurePathMissing(join(input.workspaceRoot, runtimeContract.commandDir))
  await ensurePathMissing(join(input.workspaceRoot, runtimeContract.memoryDir))
  await ensurePathMissing(join(input.workspaceRoot, runtimeContract.pluginDir, "oc-evolver.ts"))
}

async function assertInstalledScenarioArtifacts(input: {
  scenarioName: string
  workspaceRoot: string
  globalOpencodeRoot: string
  parsedResponses: ParsedEvalResponse[]
  turns: EvaluationTurn[]
  stdout: string
}) {
  await assertInstalledRootLayout({
    workspaceRoot: input.workspaceRoot,
    globalOpencodeRoot: input.globalOpencodeRoot,
  })

  const installedRoots = resolveInstalledRoots(input.globalOpencodeRoot)
  const auditEvents = await readAuditEvents(join(installedRoots.registryRoot, "audit.ndjson"))
  const registry = await readJsonFile(join(installedRoots.registryRoot, "registry.json"), {} as Record<string, unknown>)

  switch (input.scenarioName) {
    case "smoke": {
      if (input.turns.length !== 1) {
        throw new Error(`installed smoke expected exactly 1 turn, got ${input.turns.length}`)
      }

      const turnOneResponse = input.parsedResponses[0]

      if (!turnOneResponse) {
        throw new Error("installed smoke missing the first parsed response")
      }

      const executedToolSequence = collectExecutedToolSequence(turnOneResponse)

      if (!executedToolSequence.includes("evolver_status")) {
        throw new Error("installed smoke did not execute evolver_status through the installed server entrypoint")
      }

      return
    }
    case "policy-deny": {
      const denialEvent = auditEvents.find((event) => event.action === "policy_denied")

      if (!denialEvent) {
        throw new Error("installed policy-deny missing policy_denied audit event")
      }

      if (denialEvent.status !== "failure") {
        throw new Error(`installed policy-deny recorded wrong audit status: ${denialEvent.status ?? "unknown"}`)
      }

      return
    }
    case "autonomous-run": {
      if (input.turns.length !== 3) {
        throw new Error(`installed autonomous-run expected exactly 3 turns, got ${input.turns.length}`)
      }

      const turnOneResponse = input.parsedResponses[0]
      const turnTwoResponse = input.parsedResponses[1]
      const turnThreeResponse = input.parsedResponses[2]

      if (!turnOneResponse || !turnTwoResponse || !turnThreeResponse) {
        throw new Error("installed autonomous-run missing one or more parsed responses")
      }

      assertExactToolSequence(
        collectExecutedToolSequence(turnOneResponse),
        ["evolver_autonomous_start"],
        "installed autonomous-run did not follow the required turn-1 start path",
      )
      assertExactToolSequence(
        collectExecutedToolSequence(turnTwoResponse),
        ["evolver_autonomous_status"],
        "installed autonomous-run did not follow the required turn-2 autonomous-status path",
      )
      assertExactToolSequence(
        collectExecutedToolSequence(turnThreeResponse),
        ["evolver_status"],
        "installed autonomous-run did not follow the required turn-3 registry-status path",
      )

      const promoteEvent = auditEvents.find((event) => event.action === "promote" && event.status === "success")

      if (!promoteEvent) {
        throw new Error("installed autonomous-run missing promote audit evidence")
      }

      const loopState = await readJsonFile(
        join(installedRoots.registryRoot, "autonomous-loop.json"),
        {} as {
          objectives?: Array<{
            status?: string
            lastCompletionEvidence?: { satisfied?: boolean }
          }>
          iterations?: Array<{ decision?: string; rejectionReason?: string | null }>
        },
      )
      const latestIteration = loopState.iterations?.at(-1)
      const firstObjective = loopState.objectives?.[0]
      const currentRevision = (registry as { currentRevision?: unknown }).currentRevision

      if (latestIteration?.decision !== "promoted") {
        throw new Error(
          `installed autonomous-run latest iteration was ${latestIteration?.decision ?? "missing"}: ${latestIteration?.rejectionReason ?? "no rejection reason recorded"}`,
        )
      }

      if (firstObjective?.status !== "completed" || firstObjective.lastCompletionEvidence?.satisfied !== true) {
        throw new Error("installed autonomous-run did not complete the queued objective")
      }

      if (!currentRevision) {
        throw new Error("installed autonomous-run did not leave an accepted revision")
      }

      return
    }
    default: {
      throw new Error(`unsupported installed scenario: ${input.scenarioName}`)
    }
  }
}

export async function runInstalledEvaluationScenario(input: {
  repoRoot: string
  scenarioName: string
  timestamp?: string
  opencodeExecutable?: string
}): Promise<InstalledEvaluationResult> {
  if (!INSTALLED_SCENARIOS.has(input.scenarioName)) {
    throw new Error(`unsupported installed scenario: ${input.scenarioName}`)
  }

  const prompt = input.scenarioName === "autonomous-run"
    ? INSTALLED_AUTONOMOUS_PROMPT
    : await readFile(join(input.repoRoot, "eval/scenarios", `${input.scenarioName}.md`), "utf8")
  const prompts = parseScenarioPrompts(prompt)
  const workspaceParent = await mkdtemp(join(tmpdir(), `oc-evolver-installed-${input.scenarioName}-`))
  const workspaceRoot = join(workspaceParent, "workspace")
  const homeRoot = join(workspaceParent, "home")
  const xdgConfigHome = join(homeRoot, ".config")
  const globalOpencodeRoot = join(xdgConfigHome, "opencode")

  await cp(join(input.repoRoot, "eval/fixtures/base"), workspaceRoot, { recursive: true })
  await mkdir(globalOpencodeRoot, { recursive: true })

  await Promise.all([
    rm(join(workspaceRoot, runtimeContract.pluginDir), { recursive: true, force: true }),
    rm(join(workspaceRoot, runtimeContract.registryDir), { recursive: true, force: true }),
    rm(join(workspaceRoot, runtimeContract.skillDir), { recursive: true, force: true }),
    rm(join(workspaceRoot, `.opencode/${runtimeContract.nativeAgentDir}`), { recursive: true, force: true }),
    rm(join(workspaceRoot, runtimeContract.commandDir), { recursive: true, force: true }),
    rm(join(workspaceRoot, runtimeContract.memoryDir), { recursive: true, force: true }),
  ])

  await writeFile(
    join(globalOpencodeRoot, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [input.repoRoot],
      },
      null,
      2,
    )}\n`,
  )

  if (input.scenarioName === "autonomous-run") {
    await seedInstalledAutonomousRunState(globalOpencodeRoot)
  }

  const timestamp = input.timestamp ?? new Date().toISOString().replaceAll(":", "-")
  const resultDir = join(input.repoRoot, "eval/results", `installed-${input.scenarioName}`, timestamp)
  const parsedResponses: ParsedEvalResponse[] = []
  const turns: EvaluationTurn[] = []
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
    const execution = await executeOpencodeRun({
      workspaceRoot,
      command,
      env: {
        ...process.env,
        HOME: homeRoot,
        XDG_CONFIG_HOME: xdgConfigHome,
      },
      opencodeExecutable: input.opencodeExecutable ?? process.env.OPENCODE_BIN ?? "opencode",
    })
    const parsedResponse = parseOpencodeJsonStream(execution.stdout)
    const nextSessionID: string | null = extractSessionID(parsedResponse) ?? sessionID

    if (index > 0 && !nextSessionID) {
      throw new Error(`installed scenario ${input.scenarioName} lost the continued session id at turn ${index + 1}`)
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

  const installedRoots = resolveInstalledRoots(globalOpencodeRoot)

  await mkdir(resultDir, { recursive: true })
  await writeFile(join(resultDir, "stdout.txt"), combinedStdout)
  await writeFile(join(resultDir, "stderr.txt"), combinedStderr)
  await writeFile(
    join(resultDir, "result.json"),
    `${JSON.stringify(
      {
        scenarioName: input.scenarioName,
        workspaceRoot,
        globalOpencodeRoot,
        exitCode,
        command: turns.at(-1)?.command ?? [],
        turnCount: turns.length,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(join(resultDir, "response.json"), `${JSON.stringify(parsedResponses, null, 2)}\n`)
  await writeFile(join(resultDir, "turns.json"), `${JSON.stringify(turns, null, 2)}\n`)

  try {
    await writeFile(
      join(resultDir, "audit.ndjson"),
      await readFile(join(installedRoots.registryRoot, "audit.ndjson"), "utf8"),
    )
  } catch {
    await writeFile(join(resultDir, "audit.ndjson"), "")
  }

  try {
    await writeFile(
      join(resultDir, "registry.json"),
      await readFile(join(installedRoots.registryRoot, "registry.json"), "utf8"),
    )
  } catch {
    await writeFile(join(resultDir, "registry.json"), "{}\n")
  }

  try {
    await writeFile(
      join(resultDir, "autonomous-loop.json"),
      await readFile(join(installedRoots.registryRoot, "autonomous-loop.json"), "utf8"),
    )
  } catch {
    await writeFile(join(resultDir, "autonomous-loop.json"), "{}\n")
  }

  await assertInstalledScenarioArtifacts({
    scenarioName: input.scenarioName,
    workspaceRoot,
    globalOpencodeRoot,
    parsedResponses,
    turns,
    stdout: combinedStdout,
  })

  return {
    scenarioName: input.scenarioName,
    resultDir,
    workspaceRoot,
    globalOpencodeRoot,
    stdout: combinedStdout,
    stderr: combinedStderr,
    exitCode,
  }
}

async function main() {
  const scenarioArgs = process.argv.slice(2)

  if (scenarioArgs.length === 0) {
    throw new Error("usage: bun run scripts/run-installed-eval.ts <scenario> [scenario...]")
  }

  const repoRoot = fileURLToPath(new URL("..", import.meta.url))
  let failed = false

  for (const scenarioName of scenarioArgs) {
    try {
      await runInstalledEvaluationScenario({
        repoRoot,
        scenarioName,
      })
    } catch (error) {
      failed = true
      console.error(error instanceof Error ? error.message : String(error))
    }
  }

  if (failed) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main()
}
