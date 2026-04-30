import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"
import type { PermissionValue, SessionStorageMode } from "./validate.ts"

export type PersistedSessionMemoryState = {
  storageMode?: SessionStorageMode
}

export type PersistedRuntimePolicyState = {
  sourceKind: "agent" | "command"
  sourceName: string
  toolPermissions?: Record<string, PermissionValue>
  preferredModel?: string
}

export type PersistedSessionState = {
  memories?: Record<string, PersistedSessionMemoryState>
  operatorGuideApplied?: boolean
  runtimePolicy?: PersistedRuntimePolicyState
}

export async function loadPersistedSessionState(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
}): Promise<PersistedSessionState> {
  try {
    return JSON.parse(
      await readFile(resolveSessionStatePath(input.pluginFilePath, input.runtimeContract, input.sessionID), "utf8"),
    ) as PersistedSessionState
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

export async function persistSessionState(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
  state: PersistedSessionState
}) {
  const sessionStatePath = resolveSessionStatePath(
    input.pluginFilePath,
    input.runtimeContract,
    input.sessionID,
  )

  await mkdir(dirname(sessionStatePath), { recursive: true })
  await writeFile(sessionStatePath, `${JSON.stringify(input.state, null, 2)}\n`)
}

function resolveSessionStatePath(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  sessionID: string,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

  return join(kernelPaths.registryRoot, "sessions", `${encodeURIComponent(sessionID)}.json`)
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
