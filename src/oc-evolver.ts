import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { tool, type Plugin } from "@opencode-ai/plugin"

import runtimeContract from "../eval/runtime-contract.json"
import { appendAuditEvent, recordPolicyDeniedEvent } from "./kernel/audit.ts"
import {
  applyMemoryToSession,
  applySkillToSession,
  getSessionRuntimePolicy,
  getSessionStorageMode,
  rollbackRevision,
  runAgentInSession,
  runCommandInSession,
} from "./kernel/agent-runtime.ts"
import { ensureAutonomousPathAllowed } from "./kernel/policy.ts"
import {
  applyMutationTransaction,
  ensureKernelRuntimePaths,
  loadRegistry,
  promotePendingRevision,
  rejectPendingRevision,
  validateRegistryArtifacts,
} from "./kernel/registry.ts"
import {
  parseAgentDocument,
  parseCommandDocument,
  parseMemoryDocument,
  parseSkillDocument,
} from "./kernel/validate.ts"

export { ensureAutonomousPathAllowed } from "./kernel/policy.ts"

type PermissionRequest = {
  type: string
  pattern?: string | string[]
  sessionID?: string
}

const MUTATING_PERMISSION_TYPES = new Set(["create", "delete", "edit", "move", "write"])
const BASIC_MEMORY_MUTATION_TOOLS = new Set([
  "basic-memory_write_note",
  "basic-memory_edit_note",
  "basic-memory_move_note",
  "basic-memory_delete_note",
  "basic-memory_canvas",
  "basic-memory_create_memory_project",
  "basic-memory_delete_project",
])

const CONFIG_FILE_NAMES = ["opencode.jsonc", "opencode.json"]
const CONFIG_PLUGIN_HINTS = ["oc-evolver", "oc-resolver", "github.com/ryodeushii/oc-evolver"]

function resolvePluginFilePath(
  ctx: { directory: string; worktree: string },
  isDevelopmentWorkspace: boolean,
) {
  const localPluginFilePath = join(ctx.directory, runtimeContract.pluginDir, "oc-evolver.ts")

  if (isDevelopmentWorkspace) {
    return resolveGlobalPluginFilePath()
  }

  if (existsSync(localPluginFilePath) || isPluginRegisteredInOpencodeRoot(join(ctx.directory, ".opencode"))) {
    return localPluginFilePath
  }

  const globalOpencodeRoot = resolveGlobalOpencodeRoot()

  // Package-installed global plugins do not have a project-local bridge file,
  // so fall back to the global config root that registered the plugin.
  if (globalOpencodeRoot && isPluginRegisteredInOpencodeRoot(globalOpencodeRoot)) {
    return resolveGlobalPluginFilePath()
  }

  return localPluginFilePath
}

function resolveExplicitPluginFilePath(pluginEntryPointPath: string) {
  return resolve(pluginEntryPointPath)
}

function resolveGlobalOpencodeRoot() {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")

  return join(configHome, "opencode")
}

function resolveGlobalPluginFilePath() {
  return join(resolveGlobalOpencodeRoot(), "plugins", "oc-evolver.ts")
}

function isPluginRegisteredInOpencodeRoot(opencodeRoot: string) {
  for (const configFileName of CONFIG_FILE_NAMES) {
    const configPath = join(opencodeRoot, configFileName)

    if (!existsSync(configPath)) {
      continue
    }

    const configText = readFileSync(configPath, "utf8")

    if (CONFIG_PLUGIN_HINTS.some((hint) => configText.includes(hint))) {
      return true
    }
  }

  return false
}

function isKernelDevelopmentWorkspace(worktree: string) {
  const packageJsonPath = join(worktree, "package.json")
  const sourceFilePath = join(worktree, "src/oc-evolver.ts")

  if (!existsSync(packageJsonPath) || !existsSync(sourceFilePath)) {
    return false
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown
    }

    return packageJson.name === "oc-evolver"
  } catch {
    return false
  }
}

function getPermissionPatterns(permission: PermissionRequest) {
  if (!permission.pattern) {
    return []
  }

  return Array.isArray(permission.pattern) ? permission.pattern : [permission.pattern]
}

function isMutatingPermission(permission: PermissionRequest) {
  return MUTATING_PERMISSION_TYPES.has(permission.type)
}

function extractPatchTargetPaths(patchText: string) {
  const targets: string[] = []

  for (const line of patchText.split("\n")) {
    if (line.startsWith("*** Update File: ")) {
      targets.push(line.slice("*** Update File: ".length).trim())
      continue
    }

    if (line.startsWith("*** Add File: ")) {
      targets.push(line.slice("*** Add File: ".length).trim())
      continue
    }

    if (line.startsWith("*** Delete File: ")) {
      targets.push(line.slice("*** Delete File: ".length).trim())
    }
  }

  return targets
}

function resolveRuntimePermissionValue(input: {
  runtimePolicy: { toolPermissions: Record<string, "allow" | "ask" | "deny"> } | null
  toolName?: string
  permissionType?: string
}) {
  if (!input.runtimePolicy) {
    return null
  }

  if (input.toolName) {
    const toolPermission = input.runtimePolicy.toolPermissions[input.toolName]

    if (toolPermission) {
      return toolPermission
    }
  }

  if (input.permissionType) {
    return input.runtimePolicy.toolPermissions[input.permissionType] ?? null
  }

  return null
}

function getToolPermissionType(toolName: string) {
  if (toolName === "apply_patch") {
    return "edit"
  }

  return null
}

export function createOCEvolverPlugin(pluginEntryPointPath?: string): Plugin {
  return async (ctx) => {
    const isDevelopmentWorkspace = isKernelDevelopmentWorkspace(ctx.project.worktree)
    const pluginFilePath = pluginEntryPointPath
      ? resolveExplicitPluginFilePath(pluginEntryPointPath)
      : resolvePluginFilePath(ctx, isDevelopmentWorkspace)

    await ensureKernelRuntimePaths(pluginFilePath, runtimeContract)

    return {
      tool: {
        evolver_status: tool({
          description: "Show evolver registry status",
          args: {},
          async execute() {
            const registry = await loadRegistry(pluginFilePath, runtimeContract)
            return JSON.stringify(registry, null, 2)
          },
        }),
        evolver_validate: tool({
          description: "Validate a mutable artifact",
          args: {
            scope: tool.schema.enum(["document", "registry"]).optional(),
            kind: tool.schema.enum(["skill", "agent", "command", "memory"]).optional(),
            document: tool.schema.string().optional(),
          },
          async execute(args) {
            if (args.scope === "registry") {
              const result = await validateRegistryArtifacts(pluginFilePath, runtimeContract)

              return JSON.stringify({ invalid: result.invalid }, null, 2)
            }

            if (!args.kind || !args.document) {
              throw new Error("document validation requires kind and document")
            }

            if (args.kind === "skill") {
              parseSkillDocument(args.document)
            }

            if (args.kind === "agent") {
              parseAgentDocument(args.document)
            }

            if (args.kind === "command") {
              parseCommandDocument(args.document)
            }

            if (args.kind === "memory") {
              parseMemoryDocument(args.document)
            }

            await appendAuditEvent({
              pluginFilePath,
              runtimeContract,
              event: {
                action: "validate",
                status: "success",
                target: args.kind,
                detail: `validated ${args.kind} document`,
              },
            })

            return `validated ${args.kind}`
          },
        }),
        evolver_check: tool({
          description: "Check mutable roots for invalid artifacts and pending revisions",
          args: {},
          async execute() {
            const result = await validateRegistryArtifacts(pluginFilePath, runtimeContract)
            const ok = result.invalid.length === 0 && result.registry.pendingRevision === null

            await appendAuditEvent({
              pluginFilePath,
              runtimeContract,
              event: {
                action: "check",
                status: ok ? "success" : "failure",
                target: ".opencode/oc-evolver/registry.json",
                detail: ok
                  ? "mutable roots are valid and no pending revision exists"
                  : result.registry.pendingRevision
                    ? `mutable roots need attention; pending revision ${result.registry.pendingRevision} is still awaiting promotion`
                    : "mutable roots need attention due to invalid artifacts",
              },
            })

            return JSON.stringify(
              {
                ok,
                currentRevision: result.registry.currentRevision,
                pendingRevision: result.registry.pendingRevision,
                invalid: result.invalid,
              },
              null,
              2,
            )
          },
        }),
        evolver_write_skill: tool({
          description: "Write a skill bundle",
          args: {
            skillName: tool.schema.string(),
            skillDocument: tool.schema.string(),
            helperFiles: tool.schema.array(
              tool.schema.object({
                relativePath: tool.schema.string(),
                content: tool.schema.string(),
              }),
            ).default([]),
          },
          async execute(args) {
            const result = await applyMutationTransaction({
              pluginFilePath,
              runtimeContract,
              mutation: {
                kind: "skill",
                name: args.skillName,
                document: args.skillDocument,
                helperFiles: args.helperFiles,
              },
            })

            return `wrote skill ${args.skillName} at revision ${result.revisionID}`
          },
        }),
        evolver_write_agent: tool({
          description: "Write an agent document",
          args: {
            agentName: tool.schema.string(),
            document: tool.schema.string(),
          },
          async execute(args) {
            const result = await applyMutationTransaction({
              pluginFilePath,
              runtimeContract,
              mutation: {
                kind: "agent",
                name: args.agentName,
                document: args.document,
              },
            })

            return `wrote agent ${args.agentName} at revision ${result.revisionID}`
          },
        }),
        evolver_write_command: tool({
          description: "Write a command document",
          args: {
            commandName: tool.schema.string(),
            document: tool.schema.string(),
          },
          async execute(args) {
            const result = await applyMutationTransaction({
              pluginFilePath,
              runtimeContract,
              mutation: {
                kind: "command",
                name: args.commandName,
                document: args.document,
              },
            })

            return `wrote command ${args.commandName} at revision ${result.revisionID}`
          },
        }),
        evolver_write_memory: tool({
          description: "Write a memory profile",
          args: {
            memoryName: tool.schema.string(),
            document: tool.schema.string(),
          },
          async execute(args) {
            const result = await applyMutationTransaction({
              pluginFilePath,
              runtimeContract,
              mutation: {
                kind: "memory",
                name: args.memoryName,
                document: args.document,
              },
            })

            return `wrote memory ${args.memoryName} at revision ${result.revisionID}`
          },
        }),
        evolver_apply_skill: tool({
          description: "Inject a skill bundle into session",
          args: {
            skillName: tool.schema.string(),
          },
          async execute(args, toolCtx) {
            await applySkillToSession({
              client: ctx.client,
              pluginFilePath,
              runtimeContract,
              sessionID: toolCtx.sessionID,
              skillName: args.skillName,
            })

            return `applied skill ${args.skillName}`
          },
        }),
        evolver_apply_memory: tool({
          description: "Inject a memory profile into session",
          args: {
            memoryName: tool.schema.string(),
          },
          async execute(args, toolCtx) {
            await applyMemoryToSession({
              client: ctx.client,
              pluginFilePath,
              runtimeContract,
              sessionID: toolCtx.sessionID,
              memoryName: args.memoryName,
            })

            return `applied memory ${args.memoryName}`
          },
        }),
        evolver_run_agent: tool({
          description: "Run an agent in current session",
          args: {
            agentName: tool.schema.string(),
            prompt: tool.schema.string(),
          },
          async execute(args, toolCtx) {
            await runAgentInSession({
              client: ctx.client,
              pluginFilePath,
              runtimeContract,
              sessionID: toolCtx.sessionID,
              agentName: args.agentName,
              prompt: args.prompt,
            })

            return `ran agent ${args.agentName}`
          },
        }),
        evolver_run_command: tool({
          description: "Run a command in current session",
          args: {
            commandName: tool.schema.string(),
            prompt: tool.schema.string(),
          },
          async execute(args, toolCtx) {
            await runCommandInSession({
              client: ctx.client,
              pluginFilePath,
              runtimeContract,
              sessionID: toolCtx.sessionID,
              commandName: args.commandName,
              prompt: args.prompt,
            })

            return `ran command ${args.commandName}`
          },
        }),
        evolver_rollback: tool({
          description: "Rollback latest accepted revision",
          args: {},
          async execute() {
            const result = await rollbackRevision({
              pluginFilePath,
              runtimeContract,
            })

            return JSON.stringify(result)
          },
        }),
        evolver_promote: tool({
          description: "Promote pending revision to accepted",
          args: {},
          async execute() {
            const result = await promotePendingRevision(pluginFilePath, runtimeContract)

            return JSON.stringify(result)
          },
        }),
        evolver_reject: tool({
          description: "Reject pending revision and restore accepted state",
          args: {},
          async execute() {
            const result = await rejectPendingRevision(pluginFilePath, runtimeContract)

            return JSON.stringify(result)
          },
        }),
      },
      config: async () => {
        await ensureKernelRuntimePaths(pluginFilePath, runtimeContract)
      },
      "permission.ask": async (permission, output) => {
        const runtimePolicy = permission.sessionID
          ? await getSessionRuntimePolicy({
              pluginFilePath,
              runtimeContract,
              sessionID: permission.sessionID,
            })
          : null
        const runtimePermission = resolveRuntimePermissionValue({
          runtimePolicy,
          permissionType: permission.type,
        })

        if (runtimePermission === "deny") {
          output.status = "deny"
          const deniedTarget = Array.isArray(permission.pattern)
            ? permission.pattern.join(", ")
            : permission.pattern ?? permission.type

          await recordPolicyDeniedEvent({
            pluginFilePath,
            runtimeContract,
            target: deniedTarget,
            detail: `${runtimePolicy?.sourceName ?? "runtime policy"} permission ${permission.type}=deny forbids this action`,
          })

          return
        }

        if (runtimePermission === "allow") {
          output.status = "allow"
          return
        }

        if (!isMutatingPermission(permission) || isDevelopmentWorkspace) {
          return
        }

        for (const pattern of getPermissionPatterns(permission)) {
          const candidatePath = resolve(ctx.directory, pattern)

          try {
            await ensureAutonomousPathAllowed(pluginFilePath, runtimeContract, candidatePath)
          } catch (error) {
            output.status = "deny"

            await recordPolicyDeniedEvent({
              pluginFilePath,
              runtimeContract,
              target: pattern,
              detail: error instanceof Error ? error.message : String(error),
            })

            return
          }
        }
      },
      "tool.execute.before": async (input, output) => {
        const runtimePolicy = await getSessionRuntimePolicy({
          pluginFilePath,
          runtimeContract,
          sessionID: input.sessionID,
        })
        const sessionStorageMode = await getSessionStorageMode({
          pluginFilePath,
          runtimeContract,
          sessionID: input.sessionID,
        })
        const runtimePermission = resolveRuntimePermissionValue({
          runtimePolicy,
          toolName: input.tool,
          permissionType: getToolPermissionType(input.tool) ?? undefined,
        })

        if (runtimePermission === "deny") {
          const permissionType = getToolPermissionType(input.tool)
          const detail = permissionType
            ? `${runtimePolicy?.sourceName ?? "runtime policy"} permission ${permissionType}=deny forbids tool ${input.tool}`
            : `${runtimePolicy?.sourceName ?? "runtime policy"} forbids tool ${input.tool}`

          await recordPolicyDeniedEvent({
            pluginFilePath,
            runtimeContract,
            target: input.tool,
            detail,
          })

          throw new Error(detail)
        }

        if (
          sessionStorageMode === "artifact-only" &&
          BASIC_MEMORY_MUTATION_TOOLS.has(input.tool)
        ) {
          const detail =
            "basic memory mutation denied: session storage mode artifact-only forbids Basic Memory writes"

          await recordPolicyDeniedEvent({
            pluginFilePath,
            runtimeContract,
            target: input.tool,
            detail,
          })

          throw new Error(detail)
        }

        if (input.tool !== "apply_patch" || isDevelopmentWorkspace) {
          return
        }

        const patchText =
          typeof output.args?.patchText === "string"
            ? output.args.patchText
            : typeof output.args?.patch === "string"
              ? output.args.patch
              : null

        if (!patchText) {
          return
        }

        for (const targetPath of extractPatchTargetPaths(patchText)) {
          try {
            await ensureAutonomousPathAllowed(
              pluginFilePath,
              runtimeContract,
              resolve(ctx.directory, targetPath),
            )
          } catch (error) {
            await recordPolicyDeniedEvent({
              pluginFilePath,
              runtimeContract,
              target: targetPath,
              detail: error instanceof Error ? error.message : String(error),
            })

            throw error
          }
        }
      },
    }
  }
}

export const OCEvolverPlugin: Plugin = createOCEvolverPlugin()

export function createServerPlugin(_pluginModuleURL?: string): Plugin {
  return createOCEvolverPlugin(resolveGlobalPluginFilePath())
}
