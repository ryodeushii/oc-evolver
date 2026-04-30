import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { appendAuditEvent } from "./audit.ts"
import {
  materializeAgentDocument,
  materializeCommandDocument,
  materializeMemoryDocument,
  materializeSkillBundle,
} from "./materialize.ts"
import { ensureAutonomousPathAllowed } from "./policy.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"
import {
  parseAgentDocument,
  parseCommandDocument,
  parseMemoryDocument,
  parseSkillDocument,
  validateSkillBundle,
  type SkillBundleFileInput,
} from "./validate.ts"

type RegistryKind = "skill" | "agent" | "command" | "memory"

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

type MemoryRegistryEntry = RegistryEntryBase & {
  kind: "memory"
}

export type OCEvolverRegistry = {
  skills: Record<string, SkillRegistryEntry>
  agents: Record<string, AgentRegistryEntry>
  commands: Record<string, CommandRegistryEntry>
  memories: Record<string, MemoryRegistryEntry>
  quarantine: Record<string, QuarantineEntry>
  currentRevision: string | null
  pendingRevision: string | null
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
  memories: Record<string, TextRevisionEntry>
}

type RevisionRecord = {
  revisionID: string
  previousRevisionID: string | null
  previousAcceptedRevisionID: string | null
  createdAt: string
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
  | {
      kind: "memory"
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
    mkdir(kernelPaths.memoriesRoot, { recursive: true }),
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
  await collectInvalidArtifacts({
    pluginFilePath,
    runtimeContract,
    rootPath: kernelPaths.memoriesRoot,
    kind: "memory",
    shouldValidatePath: (filePath) => filePath.endsWith(".md"),
    validateDocument: parseMemoryDocument,
    invalid,
  })
  await collectRegistryIntegrityFindings({
    pluginFilePath,
    runtimeContract,
    registry,
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
  const previousRevisionID = currentRegistry.pendingRevision ?? currentRegistry.currentRevision
  const previousRevision = previousRevisionID
    ? await loadRevision(input.pluginFilePath, input.runtimeContract, previousRevisionID)
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

  const nextRegistry = buildRegistryWithEntries({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    registry: {
      ...currentRegistry,
      currentRevision: currentRegistry.currentRevision,
      pendingRevision: revisionID,
    },
    revisionID,
    entries: nextEntries,
  })

  const revisionRecord: RevisionRecord = {
    revisionID,
    previousRevisionID,
    previousAcceptedRevisionID: currentRegistry.pendingRevision
      ? previousRevision?.previousAcceptedRevisionID ?? currentRegistry.currentRevision
      : currentRegistry.currentRevision,
    createdAt: new Date().toISOString(),
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
      detail: "validated and materialized as pending revision",
    },
  })

  return {
    revisionID,
    registry: nextRegistry,
  }
}

export async function promotePendingRevision(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const registry = await loadRegistry(pluginFilePath, runtimeContract)

  if (!registry.pendingRevision) {
    throw new Error("cannot promote without a pending revision")
  }

  const pendingRevision = await loadRevision(pluginFilePath, runtimeContract, registry.pendingRevision)
  const nextRegistry = buildRegistryWithEntries({
    pluginFilePath,
    runtimeContract,
    registry: {
      ...registry,
      currentRevision: pendingRevision.revisionID,
      pendingRevision: null,
    },
    revisionID: pendingRevision.revisionID,
    entries: pendingRevision.entries,
  })

  await saveRegistry(pluginFilePath, runtimeContract, nextRegistry)
  await appendAuditEvent({
    pluginFilePath,
    runtimeContract,
    event: {
      action: "promote",
      status: "success",
      revisionID: pendingRevision.revisionID,
      target: ".opencode/oc-evolver/registry.json",
      detail: "promoted pending revision",
    },
  })

  return {
    currentRevisionID: pendingRevision.revisionID,
    pendingRevisionID: null,
  }
}

export async function rejectPendingRevision(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const registry = await loadRegistry(pluginFilePath, runtimeContract)

  if (!registry.pendingRevision) {
    throw new Error("cannot reject without a pending revision")
  }

  const rejectedRevisionID = registry.pendingRevision
  const restoredRevision = registry.currentRevision
    ? await loadRevision(pluginFilePath, runtimeContract, registry.currentRevision)
    : null
  const restoredEntries = restoredRevision?.entries ?? emptyRevisionEntries()

  await syncRegistryArtifacts({
    pluginFilePath,
    runtimeContract,
    currentRegistry: registry,
    nextEntries: restoredEntries,
  })

  const nextRegistry = restoredRevision
    ? buildRegistryWithEntries({
        pluginFilePath,
        runtimeContract,
        registry: {
          ...registry,
          currentRevision: restoredRevision.revisionID,
          pendingRevision: null,
        },
        revisionID: restoredRevision.revisionID,
        entries: restoredEntries,
      })
    : normalizeRegistry({
        ...registry,
        skills: {},
        agents: {},
        commands: {},
        memories: {},
        currentRevision: null,
        pendingRevision: null,
      })

  await saveRegistry(pluginFilePath, runtimeContract, nextRegistry)
  await appendAuditEvent({
    pluginFilePath,
    runtimeContract,
    event: {
      action: "reject",
      status: "success",
      revisionID: rejectedRevisionID,
      target: ".opencode/oc-evolver/registry.json",
      detail: restoredRevision
        ? `rejected pending revision and restored accepted revision ${restoredRevision.revisionID}`
        : "rejected pending revision and restored empty registry state",
    },
  })

  return {
    rejectedRevisionID,
    restoredRevisionID: restoredRevision?.revisionID ?? null,
  }
}

export async function rollbackLatestRevision(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const registry = await loadRegistry(pluginFilePath, runtimeContract)

  if (registry.pendingRevision) {
    throw new Error("cannot rollback while a pending revision exists")
  }

  if (!registry.currentRevision) {
    throw new Error("cannot rollback without an accepted revision")
  }

  const currentRevision = await loadRevision(pluginFilePath, runtimeContract, registry.currentRevision)

  if (!currentRevision.previousAcceptedRevisionID) {
    throw new Error("cannot rollback the initial accepted revision")
  }

  const previousRevision = await loadRevision(
    pluginFilePath,
    runtimeContract,
    currentRevision.previousAcceptedRevisionID,
  )

  await syncRegistryArtifacts({
    pluginFilePath,
    runtimeContract,
    currentRegistry: registry,
    nextEntries: previousRevision.entries,
  })

  const nextRegistry = buildRegistryWithEntries({
    pluginFilePath,
    runtimeContract,
    registry: {
      ...registry,
      currentRevision: previousRevision.revisionID,
      pendingRevision: null,
    },
    revisionID: previousRevision.revisionID,
    entries: previousRevision.entries,
  })

  await saveRegistry(pluginFilePath, runtimeContract, nextRegistry)
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

  if (input.mutation.kind === "memory") {
    const memoryDocument = parseMemoryDocument(input.mutation.document)
    const materialized = await materializeMemoryDocument({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      memoryName: input.mutation.name,
      document: input.mutation.document,
    })
    const contentHash = hashTextDocument(memoryDocument.raw)

    input.entries.memories[input.mutation.name] = {
      document: memoryDocument.raw,
      contentHash,
    }

    return {
      auditTarget: toWorkspaceRelativePath(
        input.pluginFilePath,
        input.runtimeContract,
        materialized.filePath,
      ),
      registryEntry: {
        kind: "memory" as const,
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

  for (const [name, memory] of Object.entries(input.entries.memories)) {
    await materializeMemoryDocument({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      memoryName: name,
      document: memory.document,
    })
  }
}

async function syncRegistryArtifacts(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  currentRegistry: OCEvolverRegistry
  nextEntries: RevisionEntries
}) {
  await removeRegistryArtifacts({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    registry: input.currentRegistry,
  })
  await materializeRevisionEntries({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    entries: input.nextEntries,
  })
}

async function removeRegistryArtifacts(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  registry: OCEvolverRegistry
}) {
  const skillRoots = new Set(
    Object.values(input.registry.skills).map((entry) =>
      dirname(resolveWorkspaceRelativePath(input.pluginFilePath, input.runtimeContract, entry.nativePath)),
    ),
  )

  for (const skillRoot of skillRoots) {
    await rm(skillRoot, { recursive: true, force: true })
  }

  for (const entry of Object.values(input.registry.agents)) {
    await rm(resolveWorkspaceRelativePath(input.pluginFilePath, input.runtimeContract, entry.nativePath), {
      force: true,
    })
  }

  for (const entry of Object.values(input.registry.commands)) {
    await rm(resolveWorkspaceRelativePath(input.pluginFilePath, input.runtimeContract, entry.nativePath), {
      force: true,
    })
  }

  for (const entry of Object.values(input.registry.memories)) {
    await rm(resolveWorkspaceRelativePath(input.pluginFilePath, input.runtimeContract, entry.nativePath), {
      force: true,
    })
  }
}

function buildRegistryWithEntries(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  registry: OCEvolverRegistry
  revisionID: string
  entries: RevisionEntries
}): OCEvolverRegistry {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)

  return normalizeRegistry({
    ...input.registry,
    skills: Object.fromEntries(
      Object.entries(input.entries.skills).map(([name, skill]) => {
        const skillRoot = join(kernelPaths.skillsRoot, name)

        return [
          name,
          {
            kind: "skill" as const,
            name,
            nativePath: toWorkspaceRelativePath(
              input.pluginFilePath,
              input.runtimeContract,
              join(skillRoot, "SKILL.md"),
            ),
            helperPaths: skill.helperFiles.map((helperFile) =>
              toWorkspaceRelativePath(
                input.pluginFilePath,
                input.runtimeContract,
                join(skillRoot, helperFile.relativePath),
              ),
            ),
            revisionID: input.revisionID,
            contentHash: skill.contentHash,
          },
        ]
      }),
    ),
    agents: Object.fromEntries(
      Object.entries(input.entries.agents).map(([name, agent]) => [
        name,
        {
          kind: "agent" as const,
          name,
          nativePath: toWorkspaceRelativePath(
            input.pluginFilePath,
            input.runtimeContract,
            join(kernelPaths.agentsRoot, `${name}.md`),
          ),
          revisionID: input.revisionID,
          contentHash: agent.contentHash,
        },
      ]),
    ),
    commands: Object.fromEntries(
      Object.entries(input.entries.commands).map(([name, command]) => [
        name,
        {
          kind: "command" as const,
          name,
          nativePath: toWorkspaceRelativePath(
            input.pluginFilePath,
            input.runtimeContract,
            join(kernelPaths.commandsRoot, `${name}.md`),
          ),
          revisionID: input.revisionID,
          contentHash: command.contentHash,
        },
      ]),
    ),
    memories: Object.fromEntries(
      Object.entries(input.entries.memories).map(([name, memory]) => [
        name,
        {
          kind: "memory" as const,
          name,
          nativePath: toWorkspaceRelativePath(
            input.pluginFilePath,
            input.runtimeContract,
            join(kernelPaths.memoriesRoot, `${name}.md`),
          ),
          revisionID: input.revisionID,
          contentHash: memory.contentHash,
        },
      ]),
    ),
  })
}

async function loadRevision(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  revisionID: string,
): Promise<RevisionRecord> {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)
  const revisionPath = join(kernelPaths.registryRoot, "revisions", `${revisionID}.json`)

  const revision = JSON.parse(await readFile(revisionPath, "utf8")) as Partial<RevisionRecord>

  return {
    revisionID: revision.revisionID ?? revisionID,
    previousRevisionID: revision.previousRevisionID ?? null,
    previousAcceptedRevisionID: revision.previousAcceptedRevisionID ?? revision.previousRevisionID ?? null,
    createdAt: revision.createdAt ?? new Date(0).toISOString(),
    entries: normalizeRevisionEntries(revision.entries),
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
    memories: {},
    quarantine: {},
    currentRevision: null,
    pendingRevision: null,
  }
}

function normalizeRegistry(rawRegistry: Partial<OCEvolverRegistry>): OCEvolverRegistry {
  return {
    skills: rawRegistry.skills ?? {},
    agents: rawRegistry.agents ?? {},
    commands: rawRegistry.commands ?? {},
    memories: rawRegistry.memories ?? {},
    quarantine: rawRegistry.quarantine ?? {},
    currentRevision: rawRegistry.currentRevision ?? null,
    pendingRevision: rawRegistry.pendingRevision ?? null,
  }
}

function emptyRevisionEntries(): RevisionEntries {
  return {
    skills: {},
    agents: {},
    commands: {},
    memories: {},
  }
}

function cloneRevisionEntries(entries: RevisionEntries): RevisionEntries {
  return {
    skills: structuredClone(entries.skills),
    agents: structuredClone(entries.agents),
    commands: structuredClone(entries.commands),
    memories: structuredClone(entries.memories),
  }
}

function normalizeRevisionEntries(entries: Partial<RevisionEntries> | undefined): RevisionEntries {
  return {
    skills: entries?.skills ?? {},
    agents: entries?.agents ?? {},
    commands: entries?.commands ?? {},
    memories: entries?.memories ?? {},
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

  if (kind === "memory") {
    return "write_memory"
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

function resolveWorkspaceRelativePath(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  relativePath: string,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  return resolve(dirname(kernelPaths.opencodeRoot), relativePath)
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

async function collectRegistryIntegrityFindings(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  registry: OCEvolverRegistry
  invalid: InvalidArtifact[]
}) {
  for (const entry of Object.values(input.registry.skills)) {
    await collectSkillIntegrityFindings({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      entry,
      invalid: input.invalid,
    })
  }

  for (const entry of Object.values(input.registry.agents)) {
    await collectAgentIntegrityFindings({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      entry,
      registry: input.registry,
      invalid: input.invalid,
    })
  }

  for (const entry of Object.values(input.registry.commands)) {
    await collectCommandIntegrityFindings({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      entry,
      registry: input.registry,
      invalid: input.invalid,
    })
  }

  for (const entry of Object.values(input.registry.memories)) {
    await collectMemoryIntegrityFindings({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      entry,
      invalid: input.invalid,
    })
  }
}

async function collectSkillIntegrityFindings(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  entry: SkillRegistryEntry
  invalid: InvalidArtifact[]
}) {
  const document = await readTrackedArtifact({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    target: input.entry.nativePath,
    kind: input.entry.kind,
    invalid: input.invalid,
  })

  if (document === null) {
    return
  }

  try {
    parseSkillDocument(document)
  } catch {
    return
  }

  const skillRootPath = dirname(
    resolveWorkspaceRelativePath(input.pluginFilePath, input.runtimeContract, input.entry.nativePath),
  )
  const helperFiles: SkillBundleFileInput[] = []

  for (const helperPath of input.entry.helperPaths) {
    const absoluteHelperPath = resolveWorkspaceRelativePath(
      input.pluginFilePath,
      input.runtimeContract,
      helperPath,
    )
    const helperContent = await readFileIfExists(absoluteHelperPath)

    if (helperContent === null) {
      pushInvalidArtifact(input.invalid, {
        target: input.entry.nativePath,
        kind: input.entry.kind,
        reason: `missing helper file: ${helperPath}`,
      })
      return
    }

    helperFiles.push({
      relativePath: relative(skillRootPath, absoluteHelperPath).replaceAll("\\", "/"),
      content: helperContent,
    })
  }

  const contentHash = hashSkillDocument(document, helperFiles)

  if (contentHash !== input.entry.contentHash) {
    pushInvalidArtifact(input.invalid, {
      target: input.entry.nativePath,
      kind: input.entry.kind,
      reason: `content hash mismatch for tracked ${input.entry.kind}`,
    })
  }
}

async function collectAgentIntegrityFindings(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  entry: AgentRegistryEntry
  registry: OCEvolverRegistry
  invalid: InvalidArtifact[]
}) {
  const document = await readTrackedArtifact({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    target: input.entry.nativePath,
    kind: input.entry.kind,
    invalid: input.invalid,
  })

  if (document === null) {
    return
  }

  let parsedDocument

  try {
    parsedDocument = parseAgentDocument(document)
  } catch {
    return
  }

  for (const memoryName of parsedDocument.frontmatter.memory ?? []) {
    if (!input.registry.memories[memoryName]) {
      pushInvalidArtifact(input.invalid, {
        target: input.entry.nativePath,
        kind: input.entry.kind,
        reason: `unknown memory profile referenced by agent: ${memoryName}`,
      })
    }
  }

  if (hashTextDocument(parsedDocument.raw) !== input.entry.contentHash) {
    pushInvalidArtifact(input.invalid, {
      target: input.entry.nativePath,
      kind: input.entry.kind,
      reason: `content hash mismatch for tracked ${input.entry.kind}`,
    })
  }
}

async function collectCommandIntegrityFindings(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  entry: CommandRegistryEntry
  registry: OCEvolverRegistry
  invalid: InvalidArtifact[]
}) {
  const document = await readTrackedArtifact({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    target: input.entry.nativePath,
    kind: input.entry.kind,
    invalid: input.invalid,
  })

  if (document === null) {
    return
  }

  let parsedDocument

  try {
    parsedDocument = parseCommandDocument(document)
  } catch {
    return
  }

  if (parsedDocument.frontmatter.agent && !input.registry.agents[parsedDocument.frontmatter.agent]) {
    pushInvalidArtifact(input.invalid, {
      target: input.entry.nativePath,
      kind: input.entry.kind,
      reason: `unknown agent referenced by command: ${parsedDocument.frontmatter.agent}`,
    })
  }

  if (hashTextDocument(parsedDocument.raw) !== input.entry.contentHash) {
    pushInvalidArtifact(input.invalid, {
      target: input.entry.nativePath,
      kind: input.entry.kind,
      reason: `content hash mismatch for tracked ${input.entry.kind}`,
    })
  }
}

async function collectMemoryIntegrityFindings(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  entry: MemoryRegistryEntry
  invalid: InvalidArtifact[]
}) {
  const document = await readTrackedArtifact({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    target: input.entry.nativePath,
    kind: input.entry.kind,
    invalid: input.invalid,
  })

  if (document === null) {
    return
  }

  let parsedDocument

  try {
    parsedDocument = parseMemoryDocument(document)
  } catch {
    return
  }

  if (hashTextDocument(parsedDocument.raw) !== input.entry.contentHash) {
    pushInvalidArtifact(input.invalid, {
      target: input.entry.nativePath,
      kind: input.entry.kind,
      reason: `content hash mismatch for tracked ${input.entry.kind}`,
    })
  }
}

async function readTrackedArtifact(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  target: string
  kind: RegistryKind
  invalid: InvalidArtifact[]
}) {
  const absolutePath = resolveWorkspaceRelativePath(
    input.pluginFilePath,
    input.runtimeContract,
    input.target,
  )
  const document = await readFileIfExists(absolutePath)

  if (document !== null) {
    return document
  }

  pushInvalidArtifact(input.invalid, {
    target: input.target,
    kind: input.kind,
    reason: `missing tracked artifact: ${input.target}`,
  })

  return null
}

async function readFileIfExists(filePath: string) {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }

    throw error
  }
}

function pushInvalidArtifact(invalid: InvalidArtifact[], finding: InvalidArtifact) {
  if (
    invalid.some(
      (entry) =>
        entry.target === finding.target &&
        entry.kind === finding.kind &&
        entry.reason === finding.reason,
    )
  ) {
    return
  }

  invalid.push(finding)
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
