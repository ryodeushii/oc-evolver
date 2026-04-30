import { appendFile, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

import { ensureAutonomousPathAllowed } from "./policy.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"

export type AuditEvent = {
  action:
    | "validate"
    | "write_skill"
    | "write_agent"
    | "write_command"
    | "rollback"
    | "policy_denied"
  status: "success" | "failure"
  target: string
  detail?: string
  revisionID?: string
  rolledBackRevisionID?: string
  failureClass?: string
}

export async function appendAuditEvent(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  event: AuditEvent
}) {
  const auditPath = resolveAuditPath(input.pluginFilePath, input.runtimeContract)

  await mkdir(dirname(auditPath), { recursive: true })
  await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, auditPath)

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...input.event,
  })

  try {
    await appendFile(auditPath, `${line}\n`)
  } catch {
    const tempPath = `${auditPath}.tmp-${randomUUID()}`

    await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, tempPath)

    try {
      await writeFile(tempPath, `${line}\n`)
      await appendFile(auditPath, await Bun.file(tempPath).text())
    } finally {
      await rm(tempPath, { force: true })
    }
  }
}

export async function recordPolicyDeniedEvent(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  target: string
  detail: string
}) {
  await appendAuditEvent({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    event: {
      action: "policy_denied",
      status: "failure",
      failureClass: "policy_denied",
      target: input.target,
      detail: input.detail,
    },
  })
}

export function resolveAuditPath(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  return join(kernelPaths.registryRoot, "audit.ndjson")
}
