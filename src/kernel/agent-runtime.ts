import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { appendAuditEvent } from "./audit.ts"
import { loadRegistry, rollbackLatestRevision } from "./registry.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"
import { parseAgentDocument } from "./validate.ts"

type SessionPromptClient = {
  session: {
    prompt(payload: unknown): Promise<unknown>
  }
}

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

  const skillDocument = await readFile(skillDocumentPath, "utf8")
  const helperFiles = await Promise.all(
    skillEntry.helperPaths.map(async (relativePath) => ({
      relativePath,
      content: await readFile(join(kernelPaths.opencodeRoot, relativePath.replace(/^\.opencode\//, "")), "utf8"),
    })),
  )
  const promptText = [
    `Apply skill: ${input.skillName}`,
    "Skill document:",
    skillDocument,
    ...helperFiles.map(
      (helperFile) => `Helper file: ${helperFile.relativePath}\n${helperFile.content}`,
    ),
  ].join("\n\n")

  await input.client.session.prompt({
    path: { id: input.sessionID },
    body: {
      noReply: true,
      parts: [{ type: "text", text: promptText }],
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
  const promptText = [
    `Run agent: ${input.agentName}`,
    "Agent instructions:",
    agentDocument.body,
    "User prompt:",
    input.prompt,
  ].join("\n\n")

  await input.client.session.prompt({
    path: { id: input.sessionID },
    body: {
      noReply: false,
      parts: [{ type: "text", text: promptText }],
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

export async function rollbackRevision(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
}) {
  return rollbackLatestRevision(input.pluginFilePath, input.runtimeContract)
}
