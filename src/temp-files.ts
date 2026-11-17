/**
 * Private per-session temporary directory (`0o700`) and `0o600` file writer (`wx` exclusive create,
 * immune to symlink pre-creation in shared `/tmp`), cleaned up on `session_shutdown`.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, openSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let activeTempDir: string | undefined;

export function getPrivateTempDir(): string {
  if (activeTempDir) return activeTempDir;
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-ext-"));
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows ignores POSIX mode bits */
  }
  activeTempDir = dir;
  return dir;
}

export function writePrivateTempFile(
  prefix: string,
  ext: string,
  data: string | Uint8Array,
  mode = 0o600,
): string {
  const dir = getPrivateTempDir();
  const safeExt = ext.replace(/[^a-zA-Z0-9.+-]/g, "") || "tmp";
  const name = `${prefix}-${Date.now()}-${randomBytes(6).toString("hex")}.${safeExt}`;
  const fullPath = join(dir, name);
  const fd = openSync(fullPath, "wx", mode);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(fullPath, mode);
  } catch {
    /* ignore */
  }
  return fullPath;
}

export function createPrivateSubdir(prefix: string): string {
  const base = getPrivateTempDir();
  const sub = mkdtempSync(join(base, `${prefix}-`));
  try {
    chmodSync(sub, 0o700);
  } catch {
    /* ignore */
  }
  return sub;
}

export function cleanupPrivateTempDir(): void {
  const dir = activeTempDir;
  activeTempDir = undefined;
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
