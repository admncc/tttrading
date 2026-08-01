import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { log } from "../logger.js";

const execAsync = promisify(exec);

export interface UpdateStatus {
  enabled: boolean;
  /** Short hash of the currently checked-out commit. */
  current?: string;
  /** How many commits the local branch is behind origin. */
  behind?: number;
  /** Subjects of the pending commits (newest first). */
  commits?: string[];
  error?: string;
}

const repo = () => config.selfUpdate.repoDir;

// Avoid git "dubious ownership" errors when the checkout is root-owned.
function git(args: string): string {
  return `git -c safe.directory='${repo()}' -C '${repo()}' ${args}`;
}

/** Fetch origin and report how far behind we are (read-only). */
export async function checkUpdates(): Promise<UpdateStatus> {
  if (!config.selfUpdate.enabled) return { enabled: false };
  try {
    const current = (await execAsync(git("rev-parse --short HEAD"))).stdout.trim();
    await execAsync(git("fetch --quiet"), { timeout: 30_000 });
    const behindRaw = (await execAsync(git("rev-list --count HEAD..@{u}"))).stdout.trim();
    const behind = Number(behindRaw) || 0;
    let commits: string[] = [];
    if (behind > 0) {
      const out = (await execAsync(git("log --pretty=%s -20 HEAD..@{u}"))).stdout.trim();
      commits = out ? out.split("\n") : [];
    }
    return { enabled: true, current, behind, commits };
  } catch (err) {
    return { enabled: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Pull the latest code and rebuild. In Docker this recreates the container
 * (needs the repo + docker socket mounted; see docker-compose.yml). Runs
 * detached so it survives this process being replaced.
 */
export function runUpdate(): { started: boolean; error?: string } {
  if (!config.selfUpdate.enabled) return { started: false, error: "self-update disabled" };
  const cmd =
    config.selfUpdate.command ||
    `${git("pull --ff-only")} && docker compose -f '${repo()}/docker-compose.yml' up -d --build`;
  log.warn(`Self-update triggered: ${cmd}`);
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    return { started: true };
  } catch (err) {
    return { started: false, error: err instanceof Error ? err.message : String(err) };
  }
}
