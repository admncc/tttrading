import { config } from "../config.js";
import { log, event } from "../logger.js";
import { groups as groupsRepo, signals as signalsRepo, settings as settingsRepo } from "../db/repositories.js";
import { suggestChannelInstructions, llmReady } from "./llm.js";
import { sendAlert } from "../alerts/notifier.js";
import { broadcast } from "../ws/hub.js";

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Auto-refine one channel's parsing instructions from its recent history and
 * apply the result. Respects the per-channel min-days interval. Returns true if
 * the instructions were updated.
 */
async function refineGroup(groupId: string): Promise<boolean> {
  const group = groupsRepo.get(groupId);
  if (!group) return false;

  const last = settingsRepo.getLastRefine(groupId);
  if (last) {
    const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
    if (days < config.anthropic.autoRefineDays) return false; // too soon
  }

  const history = signalsRepo.forGroup(groupId);
  if (history.length < config.anthropic.autoRefineMinMessages) return false;

  const samples = history
    .slice()
    .reverse()
    .map((s) => ({
      text: s.rawText,
      type:
        s.status === "managed"
          ? "trade-change"
          : s.parsed && s.status !== "unparseable"
            ? "signal"
            : "info",
    }));

  const res = await suggestChannelInstructions(group.name, group.settings.instructions ?? "", samples);
  // Stamp the attempt even on no-op so we don't retry every cycle.
  settingsRepo.setLastRefine(groupId, new Date().toISOString());
  if (res.error || !res.instructions) {
    log.warn(`Auto-refine ${group.name}: ${res.error ?? "no suggestion"}`);
    return false;
  }
  if (res.instructions.trim() === (group.settings.instructions ?? "").trim()) {
    return false; // unchanged
  }

  groupsRepo.update(groupId, {
    name: group.name,
    telegramChannel: group.telegramChannel,
    enabled: group.enabled,
    settings: { ...group.settings, instructions: res.instructions },
  });
  const updated = groupsRepo.get(groupId);
  if (updated) broadcast({ type: "group", group: updated });
  event(
    "system",
    `Auto-refined instructions for ${group.name}`,
    { rationale: res.rationale, sampleSize: res.sampleSize },
    { groupId },
  );
  void sendAlert(
    `🧠 <b>Instructions auto-refined</b> for ${group.name}\n${res.rationale || "(updated from recent messages)"}`,
  );
  return true;
}

async function refineAll(): Promise<void> {
  if (!llmReady()) return;
  if (!settingsRepo.getAutoRefine(config.anthropic.autoRefine)) return;
  for (const g of groupsRepo.list()) {
    try {
      await refineGroup(g.id);
    } catch (err) {
      log.error(`Auto-refine ${g.name}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Start the auto-refine scheduler: once per hour it checks whether refinement
 * is enabled and refines any channel due (per-channel min-days interval).
 */
export function startAutoRefine(): void {
  if (timer) return;
  timer = setInterval(() => {
    void refineAll();
  }, 3_600_000); // hourly check; per-channel interval gates actual work
  log.info(
    `Auto-refine scheduler active (default ${config.anthropic.autoRefine ? "on" : "off"}, ` +
      `every ${config.anthropic.autoRefineDays}d per channel).`,
  );
}

export function stopAutoRefine(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
