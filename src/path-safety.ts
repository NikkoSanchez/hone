import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

export function isLocalRequest(request: Request): boolean {
  const requestUrl = new URL(request.url);
  if (!isLocalHostname(requestUrl.hostname)) return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export async function resolveArtifactPath(inputPath: string, configuredRoot?: string) {
  const filePath = await realpath(resolve(inputPath));
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) throw new Error(`Artifact is not a file: ${filePath}`);

  const rootPath = await realpath(resolve(configuredRoot ?? dirname(filePath)));
  if (!isWithin(rootPath, filePath)) {
    throw new Error(`Artifact is outside the configured root: ${filePath}`);
  }

  return { filePath, rootPath };
}

export async function resolveSafeFile(rootPath: string, relativePath: string): Promise<string | null> {
  const decoded = decodeURIComponent(relativePath).replace(/^\/+/, "");
  if (!decoded || decoded.includes("\0")) return null;

  const candidatePath = join(rootPath, decoded);
  try {
    const canonicalPath = await realpath(candidatePath);
    const fileStats = await stat(canonicalPath);
    if (!fileStats.isFile() || !isWithin(rootPath, canonicalPath)) return null;
    return canonicalPath;
  } catch {
    return null;
  }
}

export function sessionIdForPath(filePath: string): string {
  return `path-${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}

export function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function contentTypeFor(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
