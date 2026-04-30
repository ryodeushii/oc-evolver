import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { appendAuditEvent } from "./audit.ts"
import { ensureOperatorGuideForSession } from "./operator-guide.ts"
import { loadRegistry, rollbackLatestRevision } from "./registry.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"
import {
  parseAgentDocument,
  parseMemoryDocument,
  parseSkillDocument,
  type MemoryDocument,
  type SessionStorageMode,
} from "./validate.ts"

type SessionPromptClient = {
  session: {
    prompt(payload: unknown): Promise<unknown>
  }
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

const sessionMemories = new Map<string, Map<string, SessionMemoryState>>()

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
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const registry = await loadRegistry(input.pluginFilePath, input.runtimeContract)
  const agentEntry = registry.agents[input.agentName]

  if (!agentEntry) {
    throw new Error(`unknown agent: ${input.agentName}`)
  }

  const agentPath = join(kernelPaths.agentsRoot, `${input.agentName}.md`)
  const agentDocument = parseAgentDocument(await readFile(agentPath, "utf8"))
  const memoryProfiles = await loadMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    memoryNames: mergeMemoryNames(
      await getSessionMemoryNames({
          pluginFilePath: input.pluginFilePath,
          runtimeContract: input.runtimeContract,
          sessionID: input.sessionID,
        }),
      agentDocument.frontmatter.memory ?? [],
    ),
  })

  await rememberLoadedMemoryProfiles({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
    memoryProfiles,
  })

  await promptSession({
    client: input.client,
    sessionID: input.sessionID,
    body: {
      noReply: true,
      system: [
        `Run agent: ${input.agentName}`,
        ...memoryProfiles.map(formatMemoryProfilePrompt),
        "Agent instructions:",
        agentDocument.body,
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
      target: agentEntry.nativePath,
      revisionID: agentEntry.revisionID,
      detail: `composed agent ${input.agentName} into session ${input.sessionID}`,
    },
  })
}

async function promptSession(input: {
  client: SessionPromptClient
  sessionID: string
  body: {
    noReply: true
    system?: string
    parts: Array<{ type: "text"; text: string }>
  }
}) {
  await ensureOperatorGuideForSession({
    client: input.client,
    sessionID: input.sessionID,
  })

  await input.client.session.prompt({
    path: { id: input.sessionID },
    body: input.body,
  })
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

async function rememberLoadedMemoryProfiles(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  memoryProfiles: LoadedMemoryProfile[]
}) {
  let appliedProfiles = await loadSessionMemoryState({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    sessionID: input.sessionID,
  })

  if (!appliedProfiles) {
    appliedProfiles = new Map()
    sessionMemories.set(input.sessionID, appliedProfiles)
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
  const cachedProfiles = sessionMemories.get(input.sessionID)

  if (cachedProfiles) {
    return cachedProfiles
  }

  try {
    const persistedState = JSON.parse(
      await readFile(resolveSessionStatePath(input.pluginFilePath, input.runtimeContract, input.sessionID), "utf8"),
    ) as {
      memories?: Record<string, SessionMemoryState>
    }

    const appliedProfiles = new Map(
      Object.entries(persistedState.memories ?? {}).map(([memoryName, profile]) => [
        memoryName,
        { storageMode: profile.storageMode },
      ]),
    )

    sessionMemories.set(input.sessionID, appliedProfiles)
    return appliedProfiles
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }

    throw error
  }
}

async function persistSessionMemoryState(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  appliedProfiles: Map<string, SessionMemoryState>
}) {
  const sessionStatePath = resolveSessionStatePath(
    input.pluginFilePath,
    input.runtimeContract,
    input.sessionID,
  )

  await mkdir(dirname(sessionStatePath), { recursive: true })
  await writeFile(
    sessionStatePath,
    JSON.stringify(
      {
        memories: Object.fromEntries(input.appliedProfiles.entries()),
      },
      null,
      2,
    ),
  )
}

function resolveSessionStatePath(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  sessionID: string,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  return join(kernelPaths.registryRoot, "sessions", `${encodeURIComponent(sessionID)}.json`)
}

function mergeMemoryNames(...memoryNameLists: string[][]) {
  return [...new Set(memoryNameLists.flat())]
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
