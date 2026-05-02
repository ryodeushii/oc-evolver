import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { applyMutationTransaction, loadRegistry } from "./registry.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"

const bundledSkillPath = join(dirname(fileURLToPath(import.meta.url)), "bundled-skills", "evolver-usage.md")

let _bundledSkillContent: string | null = null

async function loadBundledSkillContent(): Promise<string | null> {
  if (_bundledSkillContent !== undefined) return _bundledSkillContent

  try {
    _bundledSkillContent = await readFile(bundledSkillPath, "utf8")
  } catch {
    _bundledSkillContent = null
  }

  return _bundledSkillContent
}

export async function ensureBundledSkillRegistered(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
}) {
  const skillContent = await loadBundledSkillContent()
  if (!skillContent) return

  const registry = await loadRegistry(input.pluginFilePath, input.runtimeContract)

  if (registry.skills["evolver-usage"]) return

  await applyMutationTransaction({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    mutation: {
      kind: "skill",
      name: "evolver-usage",
      document: skillContent,
      helperFiles: [],
    },
  })
}

export async function ensureBundledSkillAppliedToSession(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  sessionID: string
}) {
  const registry = await loadRegistry(input.pluginFilePath, input.runtimeContract)

  return !!registry.skills["evolver-usage"]
}

export function getBundledSkillPromptHint(): string {
  return [
    "The evolver-usage skill is registered in the kernel. Use evolver_apply_skill(\"evolver-usage\") to load it into your session.",
    "After context compaction, re-apply it to restore the complete kernel usage reference.",
  ].join("\n")
}
