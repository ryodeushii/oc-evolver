import { dirname, join, resolve } from "node:path"

import type {
  OCEvolverKernelPaths,
  OCEvolverRuntimeContract,
} from "./types.ts"

export function resolveKernelPaths(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
): OCEvolverKernelPaths {
  const pluginRoot = resolve(dirname(pluginFilePath))
  const opencodeRoot = resolve(pluginRoot, "..")

  return {
    pluginFilePath: resolve(pluginFilePath),
    opencodeRoot,
    pluginRoot,
    registryRoot: resolve(opencodeRoot, relativeToOpencode(runtimeContract.registryDir)),
    skillsRoot: resolve(opencodeRoot, relativeToOpencode(runtimeContract.skillDir)),
    agentsRoot: resolve(opencodeRoot, relativeToOpencode(`.opencode/${runtimeContract.nativeAgentDir}`)),
    commandsRoot: resolve(opencodeRoot, relativeToOpencode(runtimeContract.commandDir)),
    memoriesRoot: resolve(opencodeRoot, relativeToOpencode(runtimeContract.memoryDir)),
    protectedFiles: [
      resolve(opencodeRoot, "opencode.json"),
      resolve(opencodeRoot, "opencode.jsonc"),
      resolve(opencodeRoot, "package.json"),
    ],
  }
}

function relativeToOpencode(pathFromWorkspaceRoot: string) {
  return pathFromWorkspaceRoot.replace(/^\.opencode\//, "")
}

export function resolveProtectedLockfilePaths(opencodeRoot: string) {
  return [
    join(opencodeRoot, "bun.lock"),
    join(opencodeRoot, "bun.lockb"),
    join(opencodeRoot, "package-lock.json"),
    join(opencodeRoot, "pnpm-lock.yaml"),
    join(opencodeRoot, "yarn.lock"),
  ]
}
