import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config, authEnabled } from "../config.js";
import { log } from "../logger.js";

const execAsync = promisify(exec);
const GIT_TIMEOUT = 30_000;

export interface UpdateStatus {
  enabled: boolean;
  current?: string;
  behind?: number;
  commits?: string[];
  error?: string;
}

const repo = () => config.selfUpdate.repoDir;

function git(args: string): string {
  return `git -c safe.directory='${repo()}' -C '${repo()}' ${args}`;
}

/** Fetch origin and report how far behind we are (read-only). */
export async function checkUpdates(): Promise<UpdateStatus> {
  if (!config.selfUpdate.enabled) return { enabled: false };
  try {
    const opts = { timeout: GIT_TIMEOUT };
    const current = (await execAsync(git("rev-parse --short HEAD"), opts)).stdout.trim();
    await execAsync(git("fetch --quiet"), opts);
    const behind = Number((await execAsync(git("rev-list --count HEAD..@{u}"), opts)).stdout.trim()) || 0;
    let commits: string[] = [];
    if (behind > 0) {
      const out = (await execAsync(git("log --pretty=%s -20 HEAD..@{u}"), opts)).stdout.trim();
      commits = out ? out.split("\n") : [];
    }
    return { enabled: true, current, behind, commits };
  } catch (err) {
    return { enabled: true, error: err instanceof Error ? err.message : String(err) };
  }
}

let updating = false;

/**
 * Pull the latest code and rebuild. Fails closed unless a desk password is set
 * (the endpoint is otherwise unauthenticated), and refuses concurrent runs.
 * The repo is mounted at the same absolute path as on the host (REPO_DIR=$PWD)
 * so `docker compose` resolves build context + bind mounts correctly.
 */
export function runUpdate(): { started: boolean; error?: string } {
  if (!config.selfUpdate.enabled) return { started: false, error: "self-update disabled" };
  // Never allow an unauthenticated self-update (would be host-root RCE).
  if (!authEnabled) {
    return { started: false, error: "refusing self-update: set DESK_PASSWORD (auth) first" };
  }
  if (updating) return { started: false, error: "an update is already running" };

  const dir = repo();
  const project = config.selfUpdate.project;
  const cmd =
    config.selfUpdate.command ||
    `cd '${dir}' && git config --global --add safe.directory '${dir}' && ` +
      `git pull --ff-only && docker compose -p '${project}' build && docker compose -p '${project}' up -d`;

  updating = true;
  log.warn(`Self-update triggered (project=${project}): ${cmd}`);
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    // Clear the lock if we're somehow still alive later (failed without recreate).
    const t = setTimeout(() => {
      updating = false;
    }, 300_000);
    (t as { unref?: () => void }).unref?.();
    return { started: true };
  } catch (err) {
    updating = false;
    return { started: false, error: err instanceof Error ? err.message : String(err) };
  }
}
