import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { appendAuditEvent } from "./audit.ts"
import {
  materializeAgentDocument,
  materializeCommandDocument,
  materializeSkillBundle,
} from "./materialize.ts"
import { ensureAutonomousPathAllowed } from "./policy.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"
import {
  parseAgentDocument,
  parseCommandDocument,
  parseSkillDocument,
  validateSkillBundle,
  type SkillBundleFileInput,
} from "./validate.ts"

type RegistryKind = "skill" | "agent" | "command"

export type InvalidArtifact = {
  target: string
  kind: RegistryKind
  reason: string
}

type QuarantineEntry = {
  kind: RegistryKind
  reason: string
  failureClass: "invalid_artifact"
}

type RegistryEntryBase = {
  kind: RegistryKind
  name: string
  nativePath: string
  revisionID: string
  contentHash: string
}

type SkillRegistryEntry = RegistryEntryBase & {
  kind: "skill"
  helperPaths: string[]
}

type AgentRegistryEntry = RegistryEntryBase & {
  kind: "agent"
}

type CommandRegistryEntry = RegistryEntryBase & {
  kind: "command"
}

export type OCEvolverRegistry = {
  skills: Record<string, SkillRegistryEntry>
  agents: Record<string, AgentRegistryEntry>
  commands: Record<string, CommandRegistryEntry>
  quarantine: Record<string, QuarantineEntry>
  currentRevision: string | null
}

type SkillRevisionEntry = {
  document: string
  helperFiles: SkillBundleFileInput[]
  contentHash: string
}

type TextRevisionEntry = {
  document: string
  contentHash: string
}

type RevisionEntries = {
  skills: Record<string, SkillRevisionEntry>
  agents: Record<string, TextRevisionEntry>
  commands: Record<string, TextRevisionEntry>
}

type RevisionRecord = {
  revisionID: string
  previousRevisionID: string | null
  createdAt: string
  registry: OCEvolverRegistry
  entries: RevisionEntries
}

type MutationInput =
  | {
      kind: "skill"
      name: string
      document: string
      helperFiles: SkillBundleFileInput[]
    }
  | {
      kind: "agent"
      name: string
      document: string
    }
  | {
      kind: "command"
      name: string
      document: string
    }

export async function loadRegistry(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
): Promise<OCEvolverRegistry> {
  const registryPath = resolveRegistryPath(pluginFilePath, runtimeContract)

  try {
    const rawRegistry = JSON.parse(await readFile(registryPath, "utf8")) as Partial<OCEvolverRegistry>

    return normalizeRegistry(rawRegistry)
  } catch {
    return emptyRegistry()
  }
}

export async function ensureKernelRuntimePaths(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  await Promise.all([
    mkdir(kernelPaths.registryRoot, { recursive: true }),
    mkdir(kernelPaths.skillsRoot, { recursive: true }),
    mkdir(kernelPaths.agentsRoot, { recursive: true }),
    mkdir(kernelPaths.commandsRoot, { recursive: true }),
  ])

  const registryPath = resolveRegistryPath(pluginFilePath, runtimeContract)

  try {
    await stat(registryPath)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error
    }

    await saveRegistry(pluginFilePath, runtimeContract, emptyRegistry())
  }
}

export async function validateRegistryArtifacts(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const registry = await loadRegistry(pluginFilePath, runtimeContract)
  const invalid: InvalidArtifact[] = []
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  await collectInvalidArtifacts({
    pluginFilePath,
    runtimeContract,
    rootPath: kernelPaths.skillsRoot,
    kind: "skill",
    shouldValidatePath: (filePath) => filePath.endsWith("/SKILL.md"),
    validateDocument: parseSkillDocument,
    invalid,
  })
  await collectInvalidArtifacts({
    pluginFilePath,
    runtimeContract,
    rootPath: kernelPaths.agentsRoot,
    kind: "agent",
    shouldValidatePath: (filePath) => filePath.endsWith(".md"),
    validateDocument: parseAgentDocument,
    invalid,
  })
  await collectInvalidArtifacts({
    pluginFilePath,
    runtimeContract,
    rootPath: kernelPaths.commandsRoot,
    kind: "command",
    shouldValidatePath: (filePath) => filePath.endsWith(".md"),
    validateDocument: parseCommandDocument,
    invalid,
  })

  const nextRegistry = normalizeRegistry({
    ...registry,
    quarantine: {},
  })

  for (const finding of invalid) {
    nextRegistry.quarantine[finding.target] = {
      kind: finding.kind,
      reason: finding.reason,
      failureClass: "invalid_artifact",
    }
  }

  await saveRegistry(pluginFilePath, runtimeContract, nextRegistry)

  if (invalid.length === 0) {
    await appendAuditEvent({
      pluginFilePath,
      runtimeContract,
      event: {
        action: "validate",
        status: "success",
        target: ".opencode/oc-evolver/registry.json",
        detail: "validated mutable roots",
      },
    })
  }

  for (const finding of invalid) {
    await appendAuditEvent({
      pluginFilePath,
      runtimeContract,
      event: {
        action: "validate",
        status: "failure",
        target: finding.target,
        detail: finding.reason,
        failureClass: "invalid_artifact",
      },
    })
  }

  return {
    invalid,
    registry: nextRegistry,
  }
}

export async function applyMutationTransaction(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  mutation: MutationInput
}) {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const currentRegistry = await loadRegistry(input.pluginFilePath, input.runtimeContract)
  const previousRevision = currentRegistry.currentRevision
    ? await loadRevision(input.pluginFilePath, input.runtimeContract, currentRegistry.currentRevision)
    : null
  const nextEntries = cloneRevisionEntries(previousRevision?.entries ?? emptyRevisionEntries())
  const revisionID = randomUUID()

  const mutationState = await materializeMutation({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    mutation: input.mutation,
    revisionID,
    entries: nextEntries,
  })

  const nextRegistry: OCEvolverRegistry = {
    ...currentRegistry,
    currentRevision: revisionID,
    skills: { ...currentRegistry.skills },
    agents: { ...currentRegistry.agents },
    commands: { ...currentRegistry.commands },
    quarantine: { ...currentRegistry.quarantine },
  }

  if (mutationState.registryEntry.kind === "skill") {
    nextRegistry.skills[mutationState.registryEntry.name] = mutationState.registryEntry
  }

  if (mutationState.registryEntry.kind === "agent") {
    nextRegistry.agents[mutationState.registryEntry.name] = mutationState.registryEntry
  }

  if (mutationState.registryEntry.kind === "command") {
    nextRegistry.commands[mutationState.registryEntry.name] = mutationState.registryEntry
  }

  const revisionRecord: RevisionRecord = {
    revisionID,
    previousRevisionID: currentRegistry.currentRevision,
    createdAt: new Date().toISOString(),
    registry: nextRegistry,
    entries: nextEntries,
  }

  await mkdir(kernelPaths.registryRoot, { recursive: true })
  await writeJSONAtomically({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    path: join(kernelPaths.registryRoot, "revisions", `${revisionID}.json`),
    value: revisionRecord,
  })
  await saveRegistry(input.pluginFilePath, input.runtimeContract, nextRegistry)
  await appendAuditEvent({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    event: {
      action: auditActionForMutation(input.mutation.kind),
      status: "success",
      revisionID,
      target: mutationState.auditTarget,
      detail: "validated and materialized",
    },
  })

  return {
    revisionID,
    registry: nextRegistry,
  }
}

export async function rollbackLatestRevision(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const registry = await loadRegistry(pluginFilePath, runtimeContract)

  if (!registry.currentRevision) {
    throw new Error("cannot rollback without an accepted revision")
  }

  const currentRevision = await loadRevision(pluginFilePath, runtimeContract, registry.currentRevision)

  if (!currentRevision.previousRevisionID) {
    throw new Error("cannot rollback the initial accepted revision")
  }

  const previousRevision = await loadRevision(
    pluginFilePath,
    runtimeContract,
    currentRevision.previousRevisionID,
  )

  await materializeRevisionEntries({
    pluginFilePath,
    runtimeContract,
    entries: previousRevision.entries,
  })
  await saveRegistry(pluginFilePath, runtimeContract, previousRevision.registry)
  await appendAuditEvent({
    pluginFilePath,
    runtimeContract,
    event: {
      action: "rollback",
      status: "success",
      target: ".opencode/oc-evolver/registry.json",
      revisionID: previousRevision.revisionID,
      rolledBackRevisionID: currentRevision.revisionID,
      detail: "restored previous accepted revision",
    },
  })

  return {
    currentRevisionID: previousRevision.revisionID,
    rolledBackRevisionID: currentRevision.revisionID,
  }
}

async function materializeMutation(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  mutation: MutationInput
  revisionID: string
  entries: RevisionEntries
}) {
  if (input.mutation.kind === "skill") {
    const bundle = validateSkillBundle({
      rootDirName: input.mutation.name,
      skillDocument: input.mutation.document,
      helperFiles: input.mutation.helperFiles,
    })
    const materialized = await materializeSkillBundle({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      bundle: {
        rootDirName: input.mutation.name,
        skillDocument: input.mutation.document,
        helperFiles: input.mutation.helperFiles,
      },
    })
    const helperPaths = materialized.writtenPaths
      .filter((path) => !path.endsWith("/SKILL.md"))
      .map((path) => toWorkspaceRelativePath(input.pluginFilePath, input.runtimeContract, path))
    const contentHash = hashSkillDocument(bundle.skillDocument.raw, bundle.helperFiles)

    input.entries.skills[input.mutation.name] = {
      document: bundle.skillDocument.raw,
      helperFiles: bundle.helperFiles,
      contentHash,
    }

    return {
      auditTarget: toWorkspaceRelativePath(
        input.pluginFilePath,
        input.runtimeContract,
        join(materialized.bundleRootPath, "SKILL.md"),
      ),
      registryEntry: {
        kind: "skill" as const,
        name: input.mutation.name,
        nativePath: toWorkspaceRelativePath(
          input.pluginFilePath,
          input.runtimeContract,
          join(materialized.bundleRootPath, "SKILL.md"),
        ),
        helperPaths,
        revisionID: input.revisionID,
        contentHash,
      },
    }
  }

  if (input.mutation.kind === "agent") {
    const agentDocument = parseAgentDocument(input.mutation.document)
    const materialized = await materializeAgentDocument({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      agentName: input.mutation.name,
      document: input.mutation.document,
    })
    const contentHash = hashTextDocument(agentDocument.raw)

    input.entries.agents[input.mutation.name] = {
      document: agentDocument.raw,
      contentHash,
    }

    return {
      auditTarget: toWorkspaceRelativePath(
        input.pluginFilePath,
        input.runtimeContract,
        materialized.filePath,
      ),
      registryEntry: {
        kind: "agent" as const,
        name: input.mutation.name,
        nativePath: toWorkspaceRelativePath(
          input.pluginFilePath,
          input.runtimeContract,
          materialized.filePath,
        ),
        revisionID: input.revisionID,
        contentHash,
      },
    }
  }

  const commandDocument = parseCommandDocument(input.mutation.document)
  const materialized = await materializeCommandDocument({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    commandName: input.mutation.name,
    document: input.mutation.document,
  })
  const contentHash = hashTextDocument(commandDocument.raw)

  input.entries.commands[input.mutation.name] = {
    document: commandDocument.raw,
    contentHash,
  }

  return {
    auditTarget: toWorkspaceRelativePath(
      input.pluginFilePath,
      input.runtimeContract,
      materialized.filePath,
    ),
    registryEntry: {
      kind: "command" as const,
      name: input.mutation.name,
      nativePath: toWorkspaceRelativePath(
        input.pluginFilePath,
        input.runtimeContract,
        materialized.filePath,
      ),
      revisionID: input.revisionID,
      contentHash,
    },
  }
}

async function materializeRevisionEntries(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  entries: RevisionEntries
}) {
  for (const [name, skill] of Object.entries(input.entries.skills)) {
    await materializeSkillBundle({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      bundle: {
        rootDirName: name,
        skillDocument: skill.document,
        helperFiles: skill.helperFiles,
      },
    })
  }

  for (const [name, agent] of Object.entries(input.entries.agents)) {
    await materializeAgentDocument({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      agentName: name,
      document: agent.document,
    })
  }

  for (const [name, command] of Object.entries(input.entries.commands)) {
    await materializeCommandDocument({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      commandName: name,
      document: command.document,
    })
  }
}

async function loadRevision(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  revisionID: string,
): Promise<RevisionRecord> {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)
  const revisionPath = join(kernelPaths.registryRoot, "revisions", `${revisionID}.json`)

  const revision = JSON.parse(await readFile(revisionPath, "utf8")) as RevisionRecord

  return {
    ...revision,
    registry: normalizeRegistry(revision.registry),
  }
}

export async function saveRegistry(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  registry: OCEvolverRegistry,
) {
  await writeJSONAtomically({
    pluginFilePath,
    runtimeContract,
    path: resolveRegistryPath(pluginFilePath, runtimeContract),
    value: normalizeRegistry(registry),
  })
}

function resolveRegistryPath(pluginFilePath: string, runtimeContract: OCEvolverRuntimeContract) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  return join(kernelPaths.registryRoot, "registry.json")
}

function emptyRegistry(): OCEvolverRegistry {
  return {
    skills: {},
    agents: {},
    commands: {},
    quarantine: {},
    currentRevision: null,
  }
}

function normalizeRegistry(rawRegistry: Partial<OCEvolverRegistry>): OCEvolverRegistry {
  return {
    skills: rawRegistry.skills ?? {},
    agents: rawRegistry.agents ?? {},
    commands: rawRegistry.commands ?? {},
    quarantine: rawRegistry.quarantine ?? {},
    currentRevision: rawRegistry.currentRevision ?? null,
  }
}

function emptyRevisionEntries(): RevisionEntries {
  return {
    skills: {},
    agents: {},
    commands: {},
  }
}

function cloneRevisionEntries(entries: RevisionEntries): RevisionEntries {
  return {
    skills: structuredClone(entries.skills),
    agents: structuredClone(entries.agents),
    commands: structuredClone(entries.commands),
  }
}

function hashSkillDocument(document: string, helperFiles: SkillBundleFileInput[]) {
  const hash = createHash("sha256")

  hash.update(document)

  for (const helperFile of [...helperFiles].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(helperFile.relativePath)
    hash.update(helperFile.content)
  }

  return hash.digest("hex")
}

function hashTextDocument(document: string) {
  return createHash("sha256").update(document).digest("hex")
}

function auditActionForMutation(kind: MutationInput["kind"]) {
  if (kind === "skill") {
    return "write_skill"
  }

  if (kind === "agent") {
    return "write_agent"
  }

  return "write_command"
}

function toWorkspaceRelativePath(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  absolutePath: string,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)
  const relativePath = relative(dirname(kernelPaths.opencodeRoot), absolutePath)

  return relativePath.replaceAll("\\", "/")
}

async function collectInvalidArtifacts(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  rootPath: string
  kind: RegistryKind
  shouldValidatePath: (filePath: string) => boolean
  validateDocument: (document: string) => unknown
  invalid: InvalidArtifact[]
}) {
  await walkDirectorySafe(input.rootPath, async (filePath) => {
    if (!input.shouldValidatePath(filePath)) {
      return
    }

    const document = await readFile(filePath, "utf8")

    try {
      input.validateDocument(document)
    } catch (error) {
      input.invalid.push({
        target: toWorkspaceRelativePath(input.pluginFilePath, input.runtimeContract, filePath),
        kind: input.kind,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

async function walkDirectorySafe(
  currentPath: string,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  let entries

  try {
    entries = await readdir(currentPath, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return
    }

    throw error
  }

  for (const entry of entries) {
    const entryPath = join(currentPath, entry.name)

    if (entry.isDirectory()) {
      await walkDirectorySafe(entryPath, onFile)
      continue
    }

    if (entry.isFile()) {
      await onFile(entryPath)
      continue
    }

    const entryStats = await stat(entryPath)

    if (entryStats.isDirectory()) {
      await walkDirectorySafe(entryPath, onFile)
    }

    if (entryStats.isFile()) {
      await onFile(entryPath)
    }
  }
}

async function writeJSONAtomically(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  path: string
  value: unknown
}) {
  const tempPath = `${input.path}.tmp-${randomUUID()}`

  await mkdir(dirname(input.path), { recursive: true })
  await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, input.path)
  await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, tempPath)

  try {
    await writeFile(tempPath, `${JSON.stringify(input.value, null, 2)}\n`)
    await rm(input.path, { force: true })
    await writeFile(input.path, await readFile(tempPath, "utf8"))
  } finally {
    await rm(tempPath, { force: true })
  }
}
