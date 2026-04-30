import type { Plugin } from "@opencode-ai/plugin"

export { ensureAutonomousPathAllowed } from "./kernel/policy.ts"

export const OCEvolverPlugin: Plugin = async () => {
  return {}
}
