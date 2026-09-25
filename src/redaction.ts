import type { ProjectData, RedactionEntry } from "./types";

export interface RedactionSegmentRef {
  trackId: string;
  trackName: string;
  segmentId: string;
  /** 1-based position inside its track */
  position: number;
  excerpt: string;
}

export interface RedactionIssue {
  id: string;
  kind: "duplicate" | "collision";
  title: string;
  detail: string;
  refs: RedactionSegmentRef[];
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Trimmed, non-empty entries, deduplicated by original name (first registration wins). */
export function activeEntries(entries: RedactionEntry[]): RedactionEntry[] {
  const seen = new Set<string>();
  const active: RedactionEntry[] = [];
  for (const entry of entries) {
    const original = entry.original.trim();
    const alias = entry.alias.trim();
    if (!original || !alias || seen.has(original)) continue;
    seen.add(original);
    active.push({ ...entry, original, alias });
  }
  return active;
}

/**
 * Replace every registered name with its alias in a single pass, so an alias
 * that happens to contain another registered name is never re-replaced.
 * Longer names win when registered names overlap (e.g. “林有德” before “林”).
 */
export function redactText(text: string, entries: RedactionEntry[]): string {
  const active = activeEntries(entries);
  if (!active.length) return text;
  const sorted = [...active].sort((a, b) => b.original.length - a.original.length);
  const pattern = new RegExp(sorted.map((entry) => escapeRegExp(entry.original)).join("|"), "g");
  const aliasByOriginal = new Map(sorted.map((entry) => [entry.original, entry.alias]));
  return text.replace(pattern, (match) => aliasByOriginal.get(match) ?? match);
}

/**
 * Find segments whose original text contains `needle`. When `maskRegistered`
 * is on, occurrences of registered names are blanked out first, so an alias
 * that only appears inside a registered name (e.g. alias “林” inside the
 * registered “林有德”) is not reported as a collision.
 */
function findSegments(project: ProjectData, needle: string, maskRegistered: boolean): RedactionSegmentRef[] {
  const refs: RedactionSegmentRef[] = [];
  const active = activeEntries(project.redactions);
  const maskPattern = maskRegistered && active.length
    ? new RegExp(
        [...active]
          .sort((a, b) => b.original.length - a.original.length)
          .map((entry) => escapeRegExp(entry.original))
          .join("|"),
        "g",
      )
    : null;
  for (const track of project.tracks) {
    track.segments.forEach((segment, index) => {
      const haystack = maskPattern ? segment.text.replace(maskPattern, "") : segment.text;
      if (!haystack.includes(needle)) return;
      refs.push({
        trackId: track.id,
        trackName: track.name,
        segmentId: segment.id,
        position: index + 1,
        excerpt: segment.text.length > 42 ? `${segment.text.slice(0, 42)}…` : segment.text,
      });
    });
  }
  return refs;
}

/**
 * Conflicts that must block a redacted export:
 *  - duplicate: the same original name was registered with two different aliases;
 *  - collision: an alias already appears in the transcript (or as a speaker
 *    name) as a different person, so readers could not tell them apart.
 */
export function collectRedactionIssues(project: ProjectData): RedactionIssue[] {
  const issues: RedactionIssue[] = [];
  const entries = project.redactions
    .map((entry) => ({ ...entry, original: entry.original.trim(), alias: entry.alias.trim() }))
    .filter((entry) => entry.original && entry.alias);

  const aliasesByOriginal = new Map<string, Set<string>>();
  for (const entry of entries) {
    const aliases = aliasesByOriginal.get(entry.original) ?? new Set<string>();
    aliases.add(entry.alias);
    aliasesByOriginal.set(entry.original, aliases);
  }
  for (const [original, aliases] of aliasesByOriginal) {
    if (aliases.size <= 1) continue;
    issues.push({
      id: `duplicate-${original}`,
      kind: "duplicate",
      title: `“${original}” 登记了 ${aliases.size} 个化名`,
      detail: `同一个人在各条轨道必须共用同一个化名，当前登记了：${[...aliases].join("、")}。请只保留一个。`,
      refs: findSegments(project, original, false),
    });
  }

  const checkedAliases = new Set<string>();
  for (const entry of entries) {
    if (checkedAliases.has(entry.alias) || entry.alias === entry.original) continue;
    checkedAliases.add(entry.alias);
    const refs = findSegments(project, entry.alias, true);
    const speakers = project.speakers.filter((speaker) => speaker.name.trim() === entry.alias);
    if (!refs.length && !speakers.length) continue;
    const speakerNote = speakers.length ? `，并且与发言人“${speakers.map((speaker) => speaker.name).join("、")}”同名` : "";
    issues.push({
      id: `collision-${entry.alias}`,
      kind: "collision",
      title: `化名“${entry.alias}”撞上原文中的名字`,
      detail: `有 ${refs.length} 个片段的原文里已出现“${entry.alias}”${speakerNote}，替换后读者将无法区分两个人。请换一个化名。`,
      refs,
    });
  }

  return issues;
}
