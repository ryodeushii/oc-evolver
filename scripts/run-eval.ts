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

const DEFAULT_SCENARIOS = [
  "smoke",
  "create-skill",
  "create-agent",
  "reuse-skill",
  "policy-deny",
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

  await syncPluginIntoFixture({ repoRoot: input.repoRoot })

  const workspaceParent = await mkdtemp(join(tmpdir(), `oc-evolver-${input.scenarioName}-`))
  const workspaceRoot = join(workspaceParent, "workspace")

  await cp(baseFixtureRoot, workspaceRoot, { recursive: true })

  const timestamp = input.timestamp ?? new Date().toISOString().replaceAll(":", "-")
  const resultDir = join(input.repoRoot, "eval/results", input.scenarioName, timestamp)
  const command = [
    "opencode",
    "run",
    "--format",
    "json",
    "--dir",
    workspaceRoot,
    "--dangerously-skip-permissions",
    prompt,
  ]
  const execution = await executeCommand({
    workspaceRoot,
    prompt,
    command,
  })
  const changedFiles = await diffDirectories(baseFixtureRoot, workspaceRoot)

  await mkdir(resultDir, { recursive: true })
  await writeFile(join(resultDir, "stdout.txt"), execution.stdout)
  await writeFile(join(resultDir, "stderr.txt"), execution.stderr)
  await writeFile(
    join(resultDir, "result.json"),
    `${JSON.stringify(
      {
        scenarioName: input.scenarioName,
        workspaceRoot,
        exitCode: execution.exitCode,
        command,
        changedFiles,
      },
      null,
      2,
    )}\n`,
  )

  const parsedResponse = parseOpencodeJsonStream(execution.stdout)

  await writeFile(join(resultDir, "response.json"), `${JSON.stringify(parsedResponse, null, 2)}\n`)

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

  return {
    scenarioName: input.scenarioName,
    resultDir,
    workspaceRoot,
    stdout: execution.stdout,
    stderr: execution.stderr,
    exitCode: execution.exitCode,
    changedFiles,
  }
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

  await walkDirectory(rootPath, async (filePath) => {
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

function shouldIgnoreChangedFile(relativePath: string) {
  if (IGNORED_CHANGED_FILES.has(relativePath)) {
    return true
  }

  return IGNORED_CHANGED_FILE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
}

async function walkDirectory(
  currentPath: string,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = join(currentPath, entry.name)

    if (entry.isDirectory()) {
      await walkDirectory(entryPath, onFile)
      continue
    }

    if (entry.isFile()) {
      await onFile(entryPath)
      continue
    }

    const entryStats = await stat(entryPath)

    if (entryStats.isDirectory()) {
      await walkDirectory(entryPath, onFile)
    }

    if (entryStats.isFile()) {
      await onFile(entryPath)
    }
  }
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
