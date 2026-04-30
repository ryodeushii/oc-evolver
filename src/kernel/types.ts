export type OCEvolverRuntimeContract = {
  opencodeVersion: string
  runFlags: string[]
  agentCreateFlags: string[]
  nativeAgentDir: string
  pluginDir: string
  registryDir: string
  skillDir: string
  commandDir: string
  memoryDir: string
}

export type OCEvolverKernelPaths = {
  pluginFilePath: string
  opencodeRoot: string
  pluginRoot: string
  registryRoot: string
  skillsRoot: string
  agentsRoot: string
  commandsRoot: string
  memoriesRoot: string
  protectedFiles: string[]
}
