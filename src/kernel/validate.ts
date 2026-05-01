import { basename, posix } from "node:path"

const AGENT_MODES = ["all", "primary", "subagent"] as const
const PERMISSION_VALUES = ["allow", "ask", "deny"] as const
const STORAGE_MODES = ["memory-only", "artifact-only", "memory-and-artifact"] as const

type AgentMode = (typeof AGENT_MODES)[number]
export type PermissionValue = (typeof PERMISSION_VALUES)[number]
export type SessionStorageMode = (typeof STORAGE_MODES)[number]

type MarkdownDocument<TFrontmatter extends Record<string, unknown>> = {
  frontmatter: TFrontmatter
  body: string
  raw: string
}

export type SkillDocument = MarkdownDocument<{
  name: string
  description: string
  memory?: string[]
}>

export type AgentDocument = MarkdownDocument<{
  description: string
  mode: AgentMode
  model?: string
  memory?: string[]
  permission?: Record<string, PermissionValue>
}>

export type CommandDocument = MarkdownDocument<{
  description: string
  agent?: string
  model?: string
  memory?: string[]
  permission?: Record<string, PermissionValue>
}>

export type MemoryDocument = MarkdownDocument<{
  name: string
  description: string
  storage_mode?: SessionStorageMode
  sources?: string[]
  queries?: string[]
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
  const memory = readOptionalStringList(parsed.frontmatter, "memory", "skill")

  return {
    frontmatter: {
      name,
      description,
      ...(memory ? { memory } : {}),
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
  const memory = readOptionalStringList(parsed.frontmatter, "memory", "agent")
  const permission = readPermissionMap(parsed.frontmatter.permission, "agent")

  return {
    frontmatter: {
      description,
      mode,
      ...(model ? { model } : {}),
      ...(memory ? { memory } : {}),
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
  const memory = readOptionalStringList(parsed.frontmatter, "memory", "command")
  const permission = readPermissionMap(parsed.frontmatter.permission, "command")

  return {
    frontmatter: {
      description,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(memory ? { memory } : {}),
      ...(permission ? { permission } : {}),
    },
    body: parsed.body,
    raw: parsed.raw,
  }
}

export function parseMemoryDocument(document: string): MemoryDocument {
  const parsed = parseMarkdownFrontmatter(document, "memory")
  const name = readRequiredString(parsed.frontmatter, "name", "memory")
  const description = readRequiredString(parsed.frontmatter, "description", "memory")
  const storageMode = readOptionalString(parsed.frontmatter, "storage_mode", "memory")
  const sources = readOptionalStringList(parsed.frontmatter, "sources", "memory")
  const queries = readOptionalStringList(parsed.frontmatter, "queries", "memory")

  let validatedStorageMode: SessionStorageMode | undefined

  if (storageMode) {
    if (!isSessionStorageMode(storageMode)) {
      throw new Error(
        "invalid memory document: storage_mode must be memory-only, artifact-only, or memory-and-artifact",
      )
    }

    validatedStorageMode = storageMode
  }

  return {
    frontmatter: {
      name,
      description,
      ...(validatedStorageMode ? { storage_mode: validatedStorageMode } : {}),
      ...(sources ? { sources } : {}),
      ...(queries ? { queries } : {}),
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

function readOptionalStringList(
  frontmatter: Record<string, unknown>,
  fieldName: string,
  artifactKind: string,
) {
  const value = frontmatter[fieldName]

  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new Error(`invalid ${artifactKind} document: ${fieldName} must be an array of strings`)
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(
        `invalid ${artifactKind} document: ${fieldName} entries must be non-empty strings`,
      )
    }

    return entry
  })
}

function readPermissionMap(value: unknown, artifactKind: string) {
  if (value === undefined) {
    return undefined
  }

  if (!isPlainObject(value)) {
    throw new Error(`invalid ${artifactKind} document: permission must be an object`)
  }

  const permissionEntries = Object.entries(value)
  const permission: Record<string, PermissionValue> = {}

  for (const [toolName, toolPermission] of permissionEntries) {
    if (!isPermissionValue(toolPermission)) {
      throw new Error(`invalid ${artifactKind} document: permission values must be allow, ask, or deny`)
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

function isSessionStorageMode(value: string): value is SessionStorageMode {
  return STORAGE_MODES.includes(value as SessionStorageMode)
}
