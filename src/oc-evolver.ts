import { existsSync } from "node:fs"
import { join } from "node:path"

import { tool, type Plugin } from "@opencode-ai/plugin"

import runtimeContract from "../eval/runtime-contract.json"
import { appendAuditEvent } from "./kernel/audit.ts"
import {
  applySkillToSession,
  rollbackRevision,
  runAgentInSession,
} from "./kernel/agent-runtime.ts"
import { resolveKernelPaths } from "./kernel/paths.ts"
import { loadRegistry, applyMutationTransaction } from "./kernel/registry.ts"
import {
  parseAgentDocument,
  parseCommandDocument,
  parseSkillDocument,
} from "./kernel/validate.ts"

export { ensureAutonomousPathAllowed } from "./kernel/policy.ts"

export const OCEvolverPlugin: Plugin = async (ctx) => {
  const pluginFilePath = join(ctx.worktree, runtimeContract.pluginDir, "oc-evolver.ts")

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
          kind: tool.schema.enum(["skill", "agent", "command"]),
          document: tool.schema.string(),
        },
        async execute(args) {
          if (args.kind === "skill") {
            parseSkillDocument(args.document)
          }

          if (args.kind === "agent") {
            parseAgentDocument(args.document)
          }

          if (args.kind === "command") {
            parseCommandDocument(args.document)
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
    },
    config: async () => {
      const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)

      if (!existsSync(kernelPaths.registryRoot)) {
        return
      }
    },
  }
}
