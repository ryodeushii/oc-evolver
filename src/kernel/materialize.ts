import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

import { ensureAutonomousPathAllowed } from "./policy.ts"
import { resolveKernelPaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"
import {
  parseAgentDocument,
  parseCommandDocument,
  parseMemoryDocument,
  validateSkillBundle,
  type SkillBundleInput,
} from "./validate.ts"

export async function materializeSkillBundle(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  bundle: SkillBundleInput
}) {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const bundle = validateSkillBundle(input.bundle)
  const bundleRootPath = join(kernelPaths.skillsRoot, bundle.rootDirName)

  await mkdir(kernelPaths.skillsRoot, { recursive: true })
  await ensureAutonomousPathAllowed(
    input.pluginFilePath,
    input.runtimeContract,
    bundleRootPath,
  )

  const writtenPaths = [join(bundleRootPath, "SKILL.md")]

  for (const helperFile of bundle.helperFiles) {
    writtenPaths.push(join(bundleRootPath, helperFile.relativePath))
  }

  for (const writtenPath of writtenPaths) {
    await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, writtenPath)
  }

  const stagingRootPath = join(
    kernelPaths.skillsRoot,
    `.tmp-${bundle.rootDirName}-${randomUUID()}`,
  )
  const backupRootPath = join(
    kernelPaths.skillsRoot,
    `.bak-${bundle.rootDirName}-${randomUUID()}`,
  )
  let existingBundleMoved = false

  await ensureAutonomousPathAllowed(
    input.pluginFilePath,
    input.runtimeContract,
    stagingRootPath,
  )
  await ensureAutonomousPathAllowed(
    input.pluginFilePath,
    input.runtimeContract,
    backupRootPath,
  )

  try {
    await mkdir(stagingRootPath, { recursive: false })
    await writeFile(join(stagingRootPath, "SKILL.md"), bundle.skillDocument.raw)

    for (const helperFile of bundle.helperFiles) {
      const helperFilePath = join(stagingRootPath, helperFile.relativePath)

      await ensureAutonomousPathAllowed(
        input.pluginFilePath,
        input.runtimeContract,
        helperFilePath,
      )
      await mkdir(dirname(helperFilePath), { recursive: true })
      await writeFile(helperFilePath, helperFile.content)
    }

    try {
      await rename(bundleRootPath, backupRootPath)
      existingBundleMoved = true
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error
      }
    }

    await rename(stagingRootPath, bundleRootPath)

    if (existingBundleMoved) {
      await rm(backupRootPath, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(stagingRootPath, { recursive: true, force: true })

    if (existingBundleMoved) {
      await rm(bundleRootPath, { recursive: true, force: true })
      await rename(backupRootPath, bundleRootPath)
    }

    throw error
  }

  return {
    bundleRootPath,
    writtenPaths,
  }
}

export async function materializeAgentDocument(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  agentName: string
  document: string
}) {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const agentDocument = parseAgentDocument(input.document)
  const filePath = join(kernelPaths.agentsRoot, `${input.agentName}.md`)

  await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, filePath)
  await mkdir(kernelPaths.agentsRoot, { recursive: true })
  await writeAtomically({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    filePath,
    content: agentDocument.raw,
  })

  return { filePath }
}

export async function materializeCommandDocument(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  commandName: string
  document: string
}) {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const commandDocument = parseCommandDocument(input.document)
  const filePath = join(kernelPaths.commandsRoot, `${input.commandName}.md`)

  await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, filePath)
  await mkdir(kernelPaths.commandsRoot, { recursive: true })
  await writeAtomically({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    filePath,
    content: commandDocument.raw,
  })

  return { filePath }
}

export async function materializeMemoryDocument(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  memoryName: string
  document: string
}) {
  const kernelPaths = resolveKernelPaths(input.pluginFilePath, input.runtimeContract)
  const memoryDocument = parseMemoryDocument(input.document)
  const filePath = join(kernelPaths.memoriesRoot, `${input.memoryName}.md`)

  await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, filePath)
  await mkdir(kernelPaths.memoriesRoot, { recursive: true })
  await writeAtomically({
    pluginFilePath: input.pluginFilePath,
    runtimeContract: input.runtimeContract,
    filePath,
    content: memoryDocument.raw,
  })

  return { filePath }
}

async function writeAtomically(input: {
  pluginFilePath: string
  runtimeContract: OCEvolverRuntimeContract
  filePath: string
  content: string
}) {
  const tempFilePath = `${input.filePath}.tmp-${randomUUID()}`

  await ensureAutonomousPathAllowed(input.pluginFilePath, input.runtimeContract, tempFilePath)

  try {
    await writeFile(tempFilePath, input.content)
    await rename(tempFilePath, input.filePath)
  } catch (error) {
    await rm(tempFilePath, { force: true })
    throw error
  }
}
