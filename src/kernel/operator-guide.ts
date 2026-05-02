import { resolveKernelPaths } from "./paths.ts"
import { loadPersistedSessionState, persistSessionState } from "./session-state.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"

const guidedSessions = new Set<string>()

type SessionPromptClient = {
  session: {
    prompt(payload: unknown): Promise<unknown>
  }
}

export function buildOperatorGuide() {
  return [
    "Operator guide:",
    "- Use evolver_status to inspect current kernel state before mutating it.",
    "- Use evolver_write_skill, evolver_write_agent, evolver_write_command, and evolver_write_memory to create or update mutable kernel artifacts under .opencode/*.",
    "- Use evolver_delete_artifact to stage removals as pending revisions, and evolver_prune to clean obsolete revision snapshots.",
    "- Use evolver_apply_skill and evolver_apply_memory to inject reusable behavior into the current session.",
    "- Use evolver_run_agent for reusable subagent behavior.",
    "- Use evolver_run_command to execute reusable command behavior, including any referenced agent instructions.",
    "- Use evolver_autonomous_configure, evolver_autonomous_status, evolver_autonomous_start, evolver_autonomous_pause, evolver_autonomous_resume, and evolver_autonomous_run to control the persisted autonomous loop.",
    "- Use evolver_promote and evolver_reject to explicitly accept or discard pending revisions during interactive sessions; autonomous runs can also auto-promote, auto-reject, and rollback accepted regressions after verification.",
    "- Use evolver_rollback to restore the previous accepted revision when a mutation turns out to be wrong.",
    "- Docs, specs, research, architecture notes, and durable knowledge default to Basic Memory unless the user asked for a repository artifact.",
    "- Respect session storage modes: memory-only, artifact-only, memory-and-artifact.",
    "- The evolver-usage skill is registered in the kernel. Use evolver_apply_skill(\"evolver-usage\") to load the complete artifact schemas, revision lifecycle, and autonomous loop reference.",
    "- After context compaction, re-apply evolver-usage to restore the full kernel usage reference.",
  ].join("\n")
}

export async function ensureOperatorGuideForSession(input: {
  client: SessionPromptClient
  pluginFilePath?: string
  runtimeContract?: OCEvolverRuntimeContract
  sessionID: string
}) {
  const sessionCacheKey = resolveSessionCacheKey(input)

  if (guidedSessions.has(sessionCacheKey)) {
    return
  }

  if (input.pluginFilePath && input.runtimeContract) {
    const persistedState = await loadPersistedSessionState({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      sessionID: input.sessionID,
    })

    if (persistedState.operatorGuideApplied) {
      guidedSessions.add(sessionCacheKey)
      return
    }
  }

  await input.client.session.prompt({
    path: { id: input.sessionID },
    body: {
      noReply: true,
      parts: [{ type: "text", text: buildOperatorGuide() }],
    },
  })

  guidedSessions.add(sessionCacheKey)

  if (input.pluginFilePath && input.runtimeContract) {
    const persistedState = await loadPersistedSessionState({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      sessionID: input.sessionID,
    })

    await persistSessionState({
      pluginFilePath: input.pluginFilePath,
      runtimeContract: input.runtimeContract,
      sessionID: input.sessionID,
      state: {
        ...persistedState,
        operatorGuideApplied: true,
      },
    })
  }
}

function resolveSessionCacheKey(input: {
  pluginFilePath?: string
  runtimeContract?: OCEvolverRuntimeContract
  sessionID: string
}) {
  if (!input.pluginFilePath || !input.runtimeContract) {
    return input.sessionID
  }

  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)

  return `${kernelPaths.registryRoot}:${input.sessionID}`
}
