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
    "- Use evolver_apply_skill and evolver_apply_memory to inject reusable behavior into the current session.",
    "- Use evolver_run_agent for reusable subagent behavior.",
    "- Use evolver_rollback to restore the previous accepted revision when a mutation turns out to be wrong.",
    "- Docs, specs, research, architecture notes, and durable knowledge default to Basic Memory unless the user asked for a repository artifact.",
    "- Respect session storage modes: memory-only, artifact-only, memory-and-artifact.",
  ].join("\n")
}

export async function ensureOperatorGuideForSession(input: {
  client: SessionPromptClient
  sessionID: string
}) {
  if (guidedSessions.has(input.sessionID)) {
    return
  }

  await input.client.session.prompt({
    path: { id: input.sessionID },
    body: {
      noReply: true,
      parts: [{ type: "text", text: buildOperatorGuide() }],
    },
  })

  guidedSessions.add(input.sessionID)
}
