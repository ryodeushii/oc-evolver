import { lstat, realpath } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"

import { resolveKernelPaths, resolveProtectedLockfilePaths } from "./paths.ts"
import type { OCEvolverRuntimeContract } from "./types.ts"

export async function isAutonomousPathAllowed(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  candidatePath: string,
) {
  try {
    await ensureAutonomousPathAllowed(pluginFilePath, runtimeContract, candidatePath)
    return true
  } catch {
    return false
  }
}

export async function ensureAutonomousPathAllowed(
  pluginFilePath: string,
  runtimeContract: OCEvolverRuntimeContract,
  candidatePath: string,
) {
  const kernelPaths = resolveKernelPaths(pluginFilePath, runtimeContract)
  const candidateAbsolutePath = resolve(candidatePath)
  const candidateCanonicalPath = await canonicalizePath(candidateAbsolutePath)

  const protectedPaths = new Set([
    kernelPaths.pluginFilePath,
    ...kernelPaths.protectedFiles,
    ...resolveProtectedLockfilePaths(kernelPaths.opencodeRoot),
  ])

  if (protectedPaths.has(candidateCanonicalPath)) {
    throw new Error(`autonomous write denied: protected path: ${candidateCanonicalPath}`)
  }

  if (isWithinPath(kernelPaths.pluginRoot, candidateCanonicalPath)) {
    throw new Error(`autonomous write denied: protected path: ${candidateCanonicalPath}`)
  }

  const allowedRoots = [
    kernelPaths.registryRoot,
    kernelPaths.skillsRoot,
    kernelPaths.agentsRoot,
    kernelPaths.commandsRoot,
  ]
  const canonicalAllowedRoots = await Promise.all(allowedRoots.map(canonicalizePath))

  if (!canonicalAllowedRoots.some((root) => isWithinPath(root, candidateCanonicalPath))) {
    if (isPathInsideWorkspace(kernelPaths.opencodeRoot, candidateAbsolutePath)) {
      throw new Error(
        `autonomous write denied: path resolves outside the allowed mutable roots: ${candidateCanonicalPath}`,
      )
    }

    throw new Error(
      `autonomous write denied: path is not in an allowed mutable root: ${candidateCanonicalPath}`,
    )
  }

  return candidateCanonicalPath
}

async function canonicalizePath(candidatePath: string) {
  const absolutePath = resolve(candidatePath)

  try {
    return await realpath(absolutePath)
  } catch {
    const { existingAncestorPath, missingSegments } = await splitAtExistingAncestor(absolutePath)
    const canonicalAncestorPath = await realpath(existingAncestorPath)

    return missingSegments.reduce((currentPath, segment) => resolve(currentPath, segment), canonicalAncestorPath)
  }
}

async function splitAtExistingAncestor(candidatePath: string) {
  const missingSegments: string[] = []
  let currentPath = candidatePath

  while (true) {
    try {
      await lstat(currentPath)

      return {
        existingAncestorPath: currentPath,
        missingSegments,
      }
    } catch {
      const parentPath = dirname(currentPath)

      if (parentPath === currentPath) {
        throw new Error(`unable to resolve an existing ancestor for path: ${candidatePath}`)
      }

      missingSegments.unshift(currentPath.slice(parentPath.length + 1))
      currentPath = parentPath
    }
  }
}

function isPathInsideWorkspace(rootPath: string, candidatePath: string) {
  const relativePath = relative(rootPath, candidatePath)

  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")
}

function isWithinPath(rootPath: string, candidatePath: string) {
  const relativePath = relative(rootPath, candidatePath)

  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")
}
