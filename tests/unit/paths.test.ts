import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import runtimeContract from "../../eval/runtime-contract.json"
import {
  ensureAutonomousPathAllowed,
  isAutonomousPathAllowed,
} from "../../src/kernel/policy.ts"
import { resolveKernelPaths } from "../../src/kernel/paths.ts"

describe("kernel path policy", () => {
  let workspaceRoot: string
  let pluginFilePath: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "oc-evolver-paths-"))
    pluginFilePath = join(workspaceRoot, ".opencode/plugins/oc-evolver.ts")

    await mkdir(join(workspaceRoot, ".opencode/plugins"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/skills"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/agent"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/commands"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/memory"), { recursive: true })
    await mkdir(join(workspaceRoot, ".opencode/oc-evolver"), { recursive: true })
    await writeFile(pluginFilePath, "export const plugin = true\n")
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  test("resolves registry and native roots beside plugin dir", () => {
    expect(resolveKernelPaths(pluginFilePath, runtimeContract)).toEqual({
      pluginFilePath,
      opencodeRoot: join(workspaceRoot, ".opencode"),
      pluginRoot: join(workspaceRoot, ".opencode/plugins"),
      registryRoot: join(workspaceRoot, ".opencode/oc-evolver"),
      skillsRoot: join(workspaceRoot, ".opencode/skills"),
      agentsRoot: join(workspaceRoot, ".opencode/agent"),
      commandsRoot: join(workspaceRoot, ".opencode/commands"),
      memoriesRoot: join(workspaceRoot, ".opencode/memory"),
      protectedFiles: [
        join(workspaceRoot, ".opencode/opencode.json"),
        join(workspaceRoot, ".opencode/opencode.jsonc"),
        join(workspaceRoot, ".opencode/package.json"),
      ],
    })
  })

  test("allows mutable skill bundle writes", async () => {
    const skillPath = join(workspaceRoot, ".opencode/skills/review/SKILL.md")

    expect(await isAutonomousPathAllowed(pluginFilePath, runtimeContract, skillPath)).toBe(
      true,
    )
  })

  test("denies kernel plugin edits", async () => {
    expect(
      await isAutonomousPathAllowed(pluginFilePath, runtimeContract, pluginFilePath),
    ).toBe(false)
  })

  test("denies traversal outside mutable roots", async () => {
    const traversedPath = join(
      workspaceRoot,
      ".opencode/skills/review/../../../package.json",
    )

    await expect(
      ensureAutonomousPathAllowed(pluginFilePath, runtimeContract, traversedPath),
    ).rejects.toThrow(/not in an allowed mutable root/i)
  })

  test("denies symlink escapes through an allowed root", async () => {
    const outsideRoot = join(workspaceRoot, "outside")
    const skillBundleRoot = join(workspaceRoot, ".opencode/skills/review")
    const escapeLink = join(skillBundleRoot, "scripts")
    const escapedTarget = join(escapeLink, "escape.ts")

    await mkdir(outsideRoot, { recursive: true })
    await mkdir(skillBundleRoot, { recursive: true })
    await symlink(outsideRoot, escapeLink)

    await expect(
      ensureAutonomousPathAllowed(pluginFilePath, runtimeContract, escapedTarget),
    ).rejects.toThrow(/resolves outside the allowed mutable roots/i)
  })

  test("allows plugin-owned registry writes", async () => {
    const revisionPath = join(workspaceRoot, ".opencode/oc-evolver/revisions/r1.json")

    expect(
      await isAutonomousPathAllowed(pluginFilePath, runtimeContract, revisionPath),
    ).toBe(true)
  })
})
