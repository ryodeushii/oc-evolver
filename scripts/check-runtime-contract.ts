import packageJson from "../package.json" with { type: "json" }
import runtimeContract from "../eval/runtime-contract.json" with { type: "json" }

const REQUIRED_AUTONOMOUS_RUN_FLAGS = [
  "--dangerously-skip-permissions",
  "--format",
  "--dir",
] as const

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const pluginVersion = packageJson.dependencies?.["@opencode-ai/plugin"]
const sdkVersion = packageJson.dependencies?.["@opencode-ai/sdk"]
const failures: string[] = []

if (!pluginVersion) {
  failures.push("package.json is missing @opencode-ai/plugin")
}

if (!sdkVersion) {
  failures.push("package.json is missing @opencode-ai/sdk")
}

if (pluginVersion && !EXACT_VERSION_PATTERN.test(pluginVersion)) {
  failures.push(`@opencode-ai/plugin must use an exact version, found ${pluginVersion}`)
}

if (sdkVersion && !EXACT_VERSION_PATTERN.test(sdkVersion)) {
  failures.push(`@opencode-ai/sdk must use an exact version, found ${sdkVersion}`)
}

if (pluginVersion && sdkVersion && pluginVersion !== sdkVersion) {
  failures.push(`OpenCode package versions must match exactly, found plugin=${pluginVersion} sdk=${sdkVersion}`)
}

if (pluginVersion && runtimeContract.opencodeVersion !== pluginVersion) {
  failures.push(
    `runtime contract mismatch: expected package version ${runtimeContract.opencodeVersion} but found dependency ${pluginVersion}`,
  )
}

const missingFlags = REQUIRED_AUTONOMOUS_RUN_FLAGS.filter((flag) => !runtimeContract.runFlags.includes(flag))

if (missingFlags.length > 0) {
  failures.push(`runtime contract is missing required autonomous run flags: ${missingFlags.join(", ")}`)
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`)
  }

  process.exit(1)
}

console.log(
  `PASS: runtime contract matches exact OpenCode dependency policy at ${runtimeContract.opencodeVersion}`,
)
