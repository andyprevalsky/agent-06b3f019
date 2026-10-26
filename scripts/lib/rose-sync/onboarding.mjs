/** Explicit onboarding: import the working checkout and configure its dependency setup. */
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

export function configureOnboarding(capture) {
  if (capture.manifest.setup.commands.length === 0) {
    capture.manifest.setup.commands = capture.manifest.setup.suggested.map(
      ({ dir, command }) => `(cd ${quote(dir || ".")} && ${command})`,
    );
  }
  return capture;
}

export function requireCapturedFiles(capture, required) {
  const captured = new Set(
    capture.files
      .filter((file) => file.content.length > 0)
      .map((file) => file.path),
  );
  const missing = required.filter((path) => !captured.has(path));
  if (missing.length) {
    throw new Error(
      `Development environment is incomplete. Import the real files: ${missing.join(", ")}`,
    );
  }
}

export function sameRepository(left, right) {
  const key = (value) =>
    value
      ?.trim()
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/^ssh:\/\/git@/, "https://")
      .replace(/\.git\/?$/, "")
      .replace(/\/$/, "");
  if (!right) return true;
  return !!left && key(left) === key(right);
}

export function isRoseRepository(url) {
  return /^(?:https:\/\/github.com\/|git@github.com:|ssh:\/\/git@github.com\/)Rose-Ai-Labs\/rose(?:\.git)?\/?$/i.test(
    url ?? "",
  );
}

export async function verifyOnboarding(call, projectId, capture) {
  const result = await call("GET", `/api/projects/${projectId}/env-files`);
  const stored = new Map(result.envFiles.map((file) => [file.path, file]));
  const missing = capture.files
    .filter((file) => !stored.get(file.path)?.hasContent)
    .map((file) => file.path);
  if (missing.length)
    throw new Error(`Environment import is incomplete: ${missing.join(", ")}`);
  return {
    status: "configured",
    environmentFiles: capture.files.map((file) => file.path),
    startupCommands: capture.manifest.setup.commands.length,
    verification: "Workspace startup has not been verified yet.",
  };
}
