import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { appendAuditEvent } from "./audit.ts"
import { ensureOperatorGuideForSession } from "./operator-guide.ts"
import { loadRegistry, rollbackLatestRevision } from "./registry.ts"
import { resolveKernelPaths } from "./paths.ts"
import {
  loadPersistedSessionState,
  persistSessionState,
  type PersistedRuntimePolicyState,
} from "./session-state.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"
import {
  parseAgentDocument,
  parseCommandDocument,
  parseMemoryDocument,
  parseSkillDocument,
  type AgentDocument,
  type CommandDocument,
  type MemoryDocument,
  type PermissionValue,
  type SessionStorageMode,
} from "./validate.ts"

type SessionPromptClient = {
  session: {
    prompt(payload: unknown): Promise<unknown>
  }
}

type SessionPromptResponse = {
  info?: Record<string, unknown>
  parts?: unknown[]
}

type SessionMemoryState = {
  storageMode?: SessionStorageMode
}

type LoadedMemoryProfile = {
  name: string
  nativePath: string
  revisionID: string
  document: MemoryDocument
}

type LoadedAgentProfile = {
  name: string
  nativePath: string
  revisionID: string
  document: AgentDocument
}

type LoadedCommandProfile = {
  name: string
  nativePath: string
  revisionID: string
  document: CommandDocument
}

type SessionRuntimePolicy = {
  sourceKind: "agent" | "command"
  sourceName: string
  toolPermissions: Record<string, PermissionValue>
  preferredModel?: string
}

const sessionMemories = new Map<string, Map<string, SessionMemoryState>>()
const sessionRuntimePolicies = new Map<string, SessionRuntimePolicy | null>()

export async function applySkillToSession(input: {
  client: SessionPromptClient
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  skillName: string
}) {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const bundleRoot = join(kernelPaths.skillsRoot, input.skillName)
  const skillDocumentPath = join(bundleRoot, "SKILL.md")
  const registry = await loadRegistry(input.pluginFilePath, input.runtimeContract)
  const skillEntry = registry.skills[input.skillName]

  if (!skillEntry) {
    throw new Error(`unknown skill: ${input.skillName}`)
  }

  const skillDocument = parseSkillDocument(await readFile(skillDocumentPath, "utf8"))
  const helperFiles = await Promise.all(
    skillEntry.helperPaths.map(async (nativePath) => ({
      nativePath,
      content: await readFile(resolveWorkspaceRelativePath(kernelPaths.opencodeRoot, nativePath), "utf8"),
    })),
  )
  const memoryProfiles = await loadMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    memoryNames: mergeMemoryNames(
      await getSessionMemoryNames({
          pluginFilePath: input.pluginFilePath,
          runtimeContract: input.runtimeContract,
          sessionID: input.sessionID,
        }),
      skillDocument.frontmatter.memory ?? [],
    ),
  })

  await rememberLoadedMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    memoryProfiles,
  })

  const promptSections = [
    `Apply skill: ${input.skillName}`,
    ...memoryProfiles.map(formatMemoryProfilePrompt),
    "Skill document:",
    skillDocument.raw,
    ...helperFiles.map(
      (helperFile) => `Helper file: ${helperFile.nativePath}\n${helperFile.content}`,
    ),
  ]

  await promptSession({
    client: input.client,
    sessionID: input.sessionID,
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    body: {
      noReply: true,
      parts: [{ type: "text", text: promptSections.join("\n\n") }],
    },
  })
  await appendAuditEvent({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    event: {
      action: "apply_skill",
      status: "success",
      target: skillEntry.nativePath,
      revisionID: skillEntry.revisionID,
      detail: `injected skill bundle ${input.skillName} into session ${input.sessionID}`,
    },
  })
}

export async function applyMemoryToSession(input: {
  client: SessionPromptClient
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  memoryName: string
}) {
  const memoryProfile = await loadMemoryProfile({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    memoryName: input.memoryName,
  })

  await rememberLoadedMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    memoryProfiles: [memoryProfile],
  })

  await promptSession({
    client: input.client,
    sessionID: input.sessionID,
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    body: {
      noReply: true,
      parts: [{ type: "text", text: formatMemoryProfilePrompt(memoryProfile) }],
    },
  })
  await appendAuditEvent({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    event: {
      action: "apply_memory",
      status: "success",
      target: memoryProfile.nativePath,
      revisionID: memoryProfile.revisionID,
      detail: `injected memory profile ${input.memoryName} into session ${input.sessionID}`,
    },
  })
}

export async function runAgentInSession(input: {
  client: SessionPromptClient
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  agentName: string
  prompt: string
}) {
  const agentProfile = await loadAgentProfile({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    agentName: input.agentName,
  })
  const memoryProfiles = await loadMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    memoryNames: mergeMemoryNames(
      await getSessionMemoryNames({
          pluginFilePath: input.pluginFilePath,
          runtimeContract: input.runtimeContract,
          sessionID: input.sessionID,
        }),
      agentProfile.document.frontmatter.memory ?? [],
    ),
  })

  await rememberLoadedMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    memoryProfiles,
  })
  await rememberSessionRuntimePolicy({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    runtimePolicy: {
      sourceKind: "agent",
      sourceName: agentProfile.name,
      toolPermissions: agentProfile.document.frontmatter.permission ?? {},
      ...(agentProfile.document.frontmatter.model
        ? { preferredModel: agentProfile.document.frontmatter.model }
        : {}),
    },
  })

  const response = await promptSession({
    client: input.client,
    sessionID: input.sessionID,
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    body: {
      system: [
        `Run agent: ${input.agentName}`,
        ...(agentProfile.document.frontmatter.model
          ? [`Preferred model: ${agentProfile.document.frontmatter.model}`]
          : []),
        ...memoryProfiles.map(formatMemoryProfilePrompt),
        "Agent instructions:",
        agentProfile.document.body,
      ].join("\n\n"),
      parts: [{ type: "text", text: input.prompt }],
    },
  })
  await appendAuditEvent({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    event: {
      action: "run_agent",
      status: "success",
      target: agentProfile.nativePath,
      revisionID: agentProfile.revisionID,
      detail: `composed agent ${input.agentName} into session ${input.sessionID}`,
    },
  })

  return {
    executionType: "agent" as const,
    agentName: input.agentName,
    sessionID: input.sessionID,
    prompt: input.prompt,
    response,
  }
}

export async function runCommandInSession(input: {
  client: SessionPromptClient
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  commandName: string
  prompt: string
}) {
  const commandProfile = await loadCommandProfile({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    commandName: input.commandName,
  })
  const agentProfile = commandProfile.document.frontmatter.agent
    ? await loadAgentProfile({
        pluginFilePath: input.pluginFilePath,
        runtimeContract: input.runtimeContract,
        agentName: commandProfile.document.frontmatter.agent,
      })
    : null
  const preferredModel = commandProfile.document.frontmatter.model ?? agentProfile?.document.frontmatter.model
  const memoryProfiles = await loadMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    memoryNames: mergeMemoryNames(
      await getSessionMemoryNames({
          pluginFilePath: input.pluginFilePath,
          runtimeContract: input.runtimeContract,
          sessionID: input.sessionID,
        }),
      commandProfile.document.frontmatter.memory ?? [],
      agentProfile?.document.frontmatter.memory ?? [],
    ),
  })

  const runtimePolicy: SessionRuntimePolicy = {
    sourceKind: "command",
    sourceName: commandProfile.name,
    toolPermissions: {
      ...(agentProfile?.document.frontmatter.permission ?? {}),
      ...(commandProfile.document.frontmatter.permission ?? {}),
    },
    ...(preferredModel ? { preferredModel } : {}),
  }
  const previousMemoryState = cloneSessionMemoryState(
    await loadSessionMemoryState({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      sessionID: input.sessionID,
    }),
  )
  const previousRuntimePolicy = await loadSessionRuntimePolicy({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
  })

  const systemSections = [
    `Run command: ${commandProfile.name}`,
    ...(agentProfile ? [`Referenced agent: ${agentProfile.name}`] : []),
    ...(preferredModel ? [`Preferred model: ${preferredModel}`] : []),
    ...memoryProfiles.map(formatMemoryProfilePrompt),
  ]

  if (agentProfile) {
    systemSections.push("Agent instructions:", agentProfile.document.body)
  }

  systemSections.push("Command instructions:", commandProfile.document.body)

  await rememberLoadedMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    memoryProfiles,
  })
  await rememberSessionRuntimePolicy({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    runtimePolicy,
  })

  let response: SessionPromptResponse

  try {
    response = await promptSession({
      client: input.client,
      sessionID: input.sessionID,
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      body: {
        system: systemSections.join("\n\n"),
        parts: [{ type: "text", text: input.prompt }],
      },
    })
  } catch (error) {
    await restoreSessionRuntimeState({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      sessionID: input.sessionID,
      memoryState: previousMemoryState,
      runtimePolicy: previousRuntimePolicy,
    })
    throw error
  }

  await appendAuditEvent({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    event: {
      action: "run_command",
      status: "success",
      target: commandProfile.nativePath,
      revisionID: commandProfile.revisionID,
      detail: `composed command ${input.commandName} into session ${input.sessionID}`,
    },
  })

  return {
    executionType: "command" as const,
    commandName: input.commandName,
    sessionID: input.sessionID,
    prompt: input.prompt,
    response,
  }
}

async function promptSession(input: {
  client: SessionPromptClient
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  body: {
    noReply?: boolean
    system?: string
    parts: Array<{ type: "text"; text: string }>
  }
}): Promise<SessionPromptResponse> {
  await ensureOperatorGuideForSession({
    client: input.client,
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
  })

  const response = await input.client.session.prompt({
    path: { id: input.sessionID },
    body: input.body,
  })

  return normalizeSessionPromptResponse(response)
}

function normalizeSessionPromptResponse(response: unknown): SessionPromptResponse {
  if (!response || typeof response !== "object") {
    return {
      info: {},
      parts: [],
    }
  }

  const record = response as { info?: unknown; parts?: unknown }

  return {
    info: record.info && typeof record.info === "object" ? (record.info as Record<string, unknown>) : {},
    parts: Array.isArray(record.parts) ? record.parts : [],
  }
}

export async function getSessionStorageMode(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
}): Promise<SessionStorageMode | null> {
  return computeSessionStorageMode(
    await loadSessionMemoryState({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      sessionID: input.sessionID,
    }),
  )
}

export async function rollbackRevision(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
}) {
  return rollbackLatestRevision(input.pluginFilePath, input.runtimeContract)
}

export async function getSessionRuntimePolicy(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
}) {
  return loadSessionRuntimePolicy(input)
}

async function loadMemoryProfiles(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  memoryNames: string[]
}) {
  const profiles: LoadedMemoryProfile[] = []

  for (const memoryName of input.memoryNames) {
    profiles.push(
      await loadMemoryProfile({
        pluginFilePath: input.pluginFilePath,
        runtimeContract: input.runtimeContract,
        memoryName,
      }),
    )
  }

  return profiles
}

async function loadMemoryProfile(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  memoryName: string
}): Promise<LoadedMemoryProfile> {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const registry = await loadRegistry(input.pluginFilePath, input.runtimeContract)
  const memoryEntry = registry.memories[input.memoryName]

  if (!memoryEntry) {
    throw new Error(`unknown memory profile: ${input.memoryName}`)
  }

  const memoryPath = join(kernelPaths.memoriesRoot, `${input.memoryName}.md`)
  const document = parseMemoryDocument(await readFile(memoryPath, "utf8"))

  return {
    name: input.memoryName,
    nativePath: memoryEntry.nativePath,
    revisionID: memoryEntry.revisionID,
    document,
  }
}

async function loadAgentProfile(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  agentName: string
}): Promise<LoadedAgentProfile> {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const registry = await loadRegistry(input.pluginFilePath, input.runtimeContract)
  const agentEntry = registry.agents[input.agentName]

  if (!agentEntry) {
    throw new Error(`unknown agent: ${input.agentName}`)
  }

  const agentPath = join(kernelPaths.agentsRoot, `${input.agentName}.md`)
  const document = parseAgentDocument(await readFile(agentPath, "utf8"))

  return {
    name: input.agentName,
    nativePath: agentEntry.nativePath,
    revisionID: agentEntry.revisionID,
    document,
  }
}

async function loadCommandProfile(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  commandName: string
}): Promise<LoadedCommandProfile> {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const registry = await loadRegistry(input.pluginFilePath, input.runtimeContract)
  const commandEntry = registry.commands[input.commandName]

  if (!commandEntry) {
    throw new Error(`unknown command: ${input.commandName}`)
  }

  const commandPath = join(kernelPaths.commandsRoot, `${input.commandName}.md`)
  const document = parseCommandDocument(await readFile(commandPath, "utf8"))

  return {
    name: input.commandName,
    nativePath: commandEntry.nativePath,
    revisionID: commandEntry.revisionID,
    document,
  }
}

async function rememberLoadedMemoryProfiles(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  memoryProfiles: LoadedMemoryProfile[]
}) {
  const sessionCacheKey = resolveSessionCacheKey(input)
  let appliedProfiles = await loadSessionMemoryState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
  })

  if (!appliedProfiles) {
    appliedProfiles = new Map()
    sessionMemories.set(sessionCacheKey, appliedProfiles)
  }

  for (const profile of input.memoryProfiles) {
    appliedProfiles.set(profile.name, {
      storageMode: profile.document.frontmatter.storage_mode,
    })
  }

  await persistSessionMemoryState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    appliedProfiles,
  })
}

async function getSessionMemoryNames(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
}) {
  return [...((await loadSessionMemoryState(input))?.keys() ?? [])]
}

function computeSessionStorageMode(appliedProfiles: Map<string, SessionMemoryState> | null) {
  if (!appliedProfiles) {
    return null
  }

  const modes = new Set(
    [...appliedProfiles.values()].flatMap((profile) =>
      profile.storageMode ? [profile.storageMode] : [],
    ),
  )

  if (modes.size === 0) {
    return null
  }

  if (modes.has("memory-and-artifact")) {
    return "memory-and-artifact"
  }

  if (modes.has("memory-only") && modes.has("artifact-only")) {
    return "memory-and-artifact"
  }

  if (modes.has("memory-only")) {
    return "memory-only"
  }

  return "artifact-only"
}

async function loadSessionMemoryState(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
}) {
  const sessionCacheKey = resolveSessionCacheKey(input)
  const cachedProfiles = sessionMemories.get(sessionCacheKey)

  if (cachedProfiles) {
    return cachedProfiles
  }

  const persistedState = await loadPersistedSessionState(input)
  const appliedProfiles = new Map(
    Object.entries(persistedState.memories ?? {}).map(([memoryName, profile]) => [
      memoryName,
      { storageMode: profile.storageMode },
    ]),
  )

  if (appliedProfiles.size === 0) {
    return null
  }

  sessionMemories.set(sessionCacheKey, appliedProfiles)
  return appliedProfiles
}

async function loadSessionRuntimePolicy(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
}): Promise<SessionRuntimePolicy | null> {
  const sessionCacheKey = resolveSessionCacheKey(input)
  const cachedPolicy = sessionRuntimePolicies.get(sessionCacheKey)

  if (cachedPolicy !== undefined) {
    return cachedPolicy
  }

  const persistedState = await loadPersistedSessionState(input)
  const runtimePolicy = persistedState.runtimePolicy
    ? hydrateRuntimePolicy(persistedState.runtimePolicy)
    : null

  sessionRuntimePolicies.set(sessionCacheKey, runtimePolicy)
  return runtimePolicy
}

async function persistSessionMemoryState(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  appliedProfiles: Map<string, SessionMemoryState>
}) {
  const persistedState = await loadPersistedSessionState(input)

  await persistSessionState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    state: {
      ...persistedState,
      memories: Object.fromEntries(input.appliedProfiles.entries()),
    },
  })
}

async function rememberSessionRuntimePolicy(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  runtimePolicy: SessionRuntimePolicy
}) {
  sessionRuntimePolicies.set(resolveSessionCacheKey(input), input.runtimePolicy)

  const persistedState = await loadPersistedSessionState(input)

  await persistSessionState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    state: {
      ...persistedState,
      runtimePolicy: serializeRuntimePolicy(input.runtimePolicy),
    },
  })
}

async function restoreSessionRuntimeState(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  memoryState: Map<string, SessionMemoryState> | null
  runtimePolicy: SessionRuntimePolicy | null
}) {
  const sessionCacheKey = resolveSessionCacheKey(input)

  if (input.memoryState) {
    sessionMemories.set(sessionCacheKey, new Map(input.memoryState.entries()))
  } else {
    sessionMemories.delete(sessionCacheKey)
  }

  if (input.runtimePolicy) {
    sessionRuntimePolicies.set(sessionCacheKey, input.runtimePolicy)
  } else {
    sessionRuntimePolicies.delete(sessionCacheKey)
  }

  const persistedState = await loadPersistedSessionState(input)

  await persistSessionState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    state: {
      ...persistedState,
      ...(input.memoryState
        ? { memories: Object.fromEntries(input.memoryState.entries()) }
        : {}),
      ...(input.memoryState ? {} : { memories: undefined }),
      ...(input.runtimePolicy ? { runtimePolicy: serializeRuntimePolicy(input.runtimePolicy) } : {}),
      ...(input.runtimePolicy ? {} : { runtimePolicy: undefined }),
    },
  })
}

function mergeMemoryNames(...memoryNameLists: string[][]) {
  return [...new Set(memoryNameLists.flat())]
}

function cloneSessionMemoryState(memoryState: Map<string, SessionMemoryState> | null) {
  return memoryState
    ? new Map(
        [...memoryState.entries()].map(([memoryName, profile]) => [memoryName, { ...profile }]),
      )
    : null
}

function formatMemoryProfilePrompt(memoryProfile: LoadedMemoryProfile) {
  const lines = [
    `Memory profile: ${memoryProfile.document.frontmatter.name}`,
    `Description: ${memoryProfile.document.frontmatter.description}`,
  ]

  if (memoryProfile.document.frontmatter.storage_mode) {
    lines.push(`Storage mode: ${memoryProfile.document.frontmatter.storage_mode}`)
  }

  if (memoryProfile.document.frontmatter.sources?.length) {
    lines.push(
      "Sources:",
      ...memoryProfile.document.frontmatter.sources.map((source) => `- ${source}`),
    )
  }

  if (memoryProfile.document.frontmatter.queries?.length) {
    lines.push(
      "Queries:",
      ...memoryProfile.document.frontmatter.queries.map((query) => `- ${query}`),
    )
  }

  const trimmedBody = memoryProfile.document.body.trim()

  if (trimmedBody) {
    lines.push("Instructions:", trimmedBody)
  }

  return lines.join("\n")
}

function resolveWorkspaceRelativePath(opencodeRoot: string, nativePath: string) {
  return resolve(dirname(opencodeRoot), nativePath)
}

function resolveSessionCacheKey(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
}) {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)

  return `${kernelPaths.registryRoot}:${input.sessionID}`
}

function serializeRuntimePolicy(runtimePolicy: SessionRuntimePolicy): PersistedRuntimePolicyState {
  return {
    sourceKind: runtimePolicy.sourceKind,
    sourceName: runtimePolicy.sourceName,
    ...(Object.keys(runtimePolicy.toolPermissions).length > 0
      ? { toolPermissions: runtimePolicy.toolPermissions }
      : {}),
    ...(runtimePolicy.preferredModel ? { preferredModel: runtimePolicy.preferredModel } : {}),
  }
}

function hydrateRuntimePolicy(runtimePolicy: PersistedRuntimePolicyState): SessionRuntimePolicy {
  return {
    sourceKind: runtimePolicy.sourceKind,
    sourceName: runtimePolicy.sourceName,
    toolPermissions: runtimePolicy.toolPermissions ?? {},
    ...(runtimePolicy.preferredModel ? { preferredModel: runtimePolicy.preferredModel } : {}),
  }
}
