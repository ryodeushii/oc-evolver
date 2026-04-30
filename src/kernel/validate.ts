import { basename, posix } from "node:path"

const AGENT_MODES = ["all", "primary", "subagent"] as const
const PERMISSION_VALUES = ["allow", "ask", "deny"] as const

type AgentMode = (typeof AGENT_MODES)[number]
type PermissionValue = (typeof PERMISSION_VALUES)[number]

type MarkdownDocument<TFrontmatter extends Record<string, unknown>> = {
  frontmatter: TFrontmatter
  body: string
  raw: string
}

export type SkillDocument = MarkdownDocument<{
  name: string
  description: string
}>

export type AgentDocument = MarkdownDocument<{
  description: string
  mode: AgentMode
  model?: string
  permission?: Record<string, PermissionValue>
}>

export type CommandDocument = MarkdownDocument<{
  description: string
  agent?: string
  model?: string
}>

export type SkillBundleInput = {
  rootDirName: string
  skillDocument: string
  helperFiles: SkillBundleFileInput[]
}

export type SkillBundleFileInput = {
  relativePath: string
  content: string
}

export type ValidatedSkillBundle = {
  rootDirName: string
  skillDocument: SkillDocument
  helperFiles: Array<SkillBundleFileInput>
}

export function parseSkillDocument(document: string): SkillDocument {
  const parsed = parseMarkdownFrontmatter(document, "skill")
  const name = readRequiredString(parsed.frontmatter, "name", "skill")
  const description = readRequiredString(parsed.frontmatter, "description", "skill")

  return {
    frontmatter: {
      name,
      description,
    },
    body: parsed.body,
    raw: parsed.raw,
  }
}

export function validateSkillBundle(bundle: SkillBundleInput): ValidatedSkillBundle {
  validateArtifactName(bundle.rootDirName, "skill bundle")

  const skillDocument = parseSkillDocument(bundle.skillDocument)
  const helperFiles = bundle.helperFiles.map((helperFile) => ({
    relativePath: normalizeBundlePath(helperFile.relativePath),
    content: helperFile.content,
  }))

  return {
    rootDirName: bundle.rootDirName,
    skillDocument,
    helperFiles,
  }
}

export function parseAgentDocument(document: string): AgentDocument {
  const parsed = parseMarkdownFrontmatter(document, "agent")
  const description = readRequiredString(parsed.frontmatter, "description", "agent")
  const mode = readRequiredString(parsed.frontmatter, "mode", "agent")

  if (!isAgentMode(mode)) {
    throw new Error("invalid agent document: mode must be one of all, primary, or subagent")
  }

  const model = readOptionalString(parsed.frontmatter, "model", "agent")
  const permission = readPermissionMap(parsed.frontmatter.permission)

  return {
    frontmatter: {
      description,
      mode,
      ...(model ? { model } : {}),
      ...(permission ? { permission } : {}),
    },
    body: parsed.body,
    raw: parsed.raw,
  }
}

export function parseCommandDocument(document: string): CommandDocument {
  const parsed = parseMarkdownFrontmatter(document, "command")
  const description = readRequiredString(parsed.frontmatter, "description", "command")
  const agent = readOptionalString(parsed.frontmatter, "agent", "command")
  const model = readOptionalString(parsed.frontmatter, "model", "command")

  return {
    frontmatter: {
      description,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
    },
    body: parsed.body,
    raw: parsed.raw,
  }
}

function parseMarkdownFrontmatter(document: string, artifactKind: string) {
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)

  if (!match) {
    const missingFields = artifactKind === "skill" ? ": name and description" : ""

    throw new Error(`invalid ${artifactKind} document: required frontmatter fields are missing${missingFields}`)
  }

  const [, rawFrontmatter = "", body = ""] = match

  let frontmatter: unknown

  try {
    frontmatter = Bun.YAML.parse(rawFrontmatter)
  } catch (error) {
    throw new Error(
      `invalid ${artifactKind} document: frontmatter is not valid YAML: ${String(error)}`,
    )
  }

  if (!isPlainObject(frontmatter)) {
    throw new Error(`invalid ${artifactKind} document: frontmatter must be a YAML object`)
  }

  return {
    frontmatter,
    body,
    raw: document,
  }
}

function readRequiredString(
  frontmatter: Record<string, unknown>,
  fieldName: string,
  artifactKind: string,
) {
  const value = frontmatter[fieldName]

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `invalid ${artifactKind} document: ${fieldName} is required in frontmatter`,
    )
  }

  return value
}

function readOptionalString(
  frontmatter: Record<string, unknown>,
  fieldName: string,
  artifactKind: string,
) {
  const value = frontmatter[fieldName]

  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `invalid ${artifactKind} document: ${fieldName} must be a non-empty string`,
    )
  }

  return value
}

function readPermissionMap(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  if (!isPlainObject(value)) {
    throw new Error("invalid agent document: permission must be an object")
  }

  const permissionEntries = Object.entries(value)
  const permission: Record<string, PermissionValue> = {}

  for (const [toolName, toolPermission] of permissionEntries) {
    if (!isPermissionValue(toolPermission)) {
      throw new Error(
        "invalid agent document: permission values must be allow, ask, or deny",
      )
    }

    permission[toolName] = toolPermission
  }

  return permission
}

function normalizeBundlePath(relativePath: string) {
  if (relativePath.trim() === "") {
    throw new Error("invalid skill bundle: helper file path is required")
  }

  const normalizedPath = posix.normalize(relativePath.replaceAll("\\", "/"))

  if (
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.startsWith("/")
  ) {
    throw new Error(
      `invalid skill bundle: helper file path must stay within the skill bundle: ${relativePath}`,
    )
  }

  return normalizedPath
}

function validateArtifactName(name: string, artifactKind: string) {
  if (name.trim() === "" || basename(name) !== name || name === "." || name === "..") {
    throw new Error(`invalid ${artifactKind}: root name must be a single path segment`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAgentMode(value: string): value is AgentMode {
  return AGENT_MODES.includes(value as AgentMode)
}

function isPermissionValue(value: unknown): value is PermissionValue {
  return typeof value === "string" && PERMISSION_VALUES.includes(value as PermissionValue)
}
