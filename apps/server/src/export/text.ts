import type { Group, Signal } from "@tttrading/shared";
import { groups as groupsRepo, signals as signalsRepo } from "../db/repositories.js";

function stamp(iso: string): string {
  // "2026-07-15 14:32:07"
  return iso.replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");
}

function parseSummary(s: Signal): string {
  const p = s.parsed;
  if (!p) return s.status;
  const bits = [`${p.side.toUpperCase()} ${p.symbol}`];
  if (p.entry !== undefined) bits.push(`entry ${p.entry}`);
  if (p.stopLoss !== undefined) bits.push(`SL ${p.stopLoss}`);
  if (p.takeProfits?.length) bits.push(`TP ${p.takeProfits.join("/")}`);
  const risk = s.risk ? ` risk=${s.risk.level}` : "";
  return `${s.status} · parsed: ${bits.join(" ")} (${Math.round(p.confidence * 100)}% ${p.source})${risk}`;
}

/** Full chronological transcript of one channel as plain text. */
export function exportGroupText(group: Group): string {
  const sigs = signalsRepo.forGroup(group.id);
  const lines: string[] = [];
  lines.push(`Channel: ${group.name}  (${group.telegramChannel})`);
  lines.push(`Messages: ${sigs.length}`);
  lines.push(`Exported: ${stamp(new Date().toISOString())}`);
  lines.push("=".repeat(72));
  lines.push("");
  for (const s of sigs) {
    lines.push(`[${stamp(s.receivedAt)}]  ${parseSummary(s)}`);
    lines.push(s.rawText.trim());
    lines.push("-".repeat(72));
  }
  return lines.join("\n");
}

export function safeFilename(name: string): string {
  const base = name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "channel";
  return `${base}.txt`;
}

/** All channels concatenated into one text file. */
export function exportAllText(): string {
  const all = groupsRepo.list();
  return all.map((g) => exportGroupText(g)).join("\n\n\n");
}
