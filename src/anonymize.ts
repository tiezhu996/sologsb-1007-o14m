import type { AliasEntry, ProjectData } from "./types";

export interface SegmentRef {
  trackId: string;
  trackName: string;
  segmentId: string;
  /** 片段在所属轨道内的序号，从 1 开始。 */
  index: number;
  start: number;
  end: number;
}

export interface AliasIssue {
  /** duplicate-source：同一原名登记了多个不同化名；alias-collision：化名撞上原文人物。 */
  code: "duplicate-source" | "alias-collision";
  /** 涉及的化名登记条目 id，用于在登记表里定位。 */
  entryIds: string[];
  source?: string;
  aliases?: string[];
  alias?: string;
  /** collision 时说明化名与什么重名。 */
  reasons: string[];
  segments: SegmentRef[];
}

export interface AnonPart {
  value: string;
  masked: boolean;
}

const validEntries = (entries: AliasEntry[]) =>
  entries.filter((entry) => entry.source.trim() && entry.alias.trim());

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 把所有原名拼成一条正则，按长度降序排列后单次扫描：
 * 既能优先匹配更长的原名，也保证化名即使恰好是另一条原名也不会被连锁替换。
 * 拉丁字母/数字构成的原名附加词边界判断，避免英文片段里误伤半个单词。
 */
function buildPattern(entries: AliasEntry[]) {
  const sources = [...new Set(validEntries(entries).map((entry) => entry.source.trim()))];
  if (!sources.length) return null;
  sources.sort((a, b) => b.length - a.length);
  const alternation = sources
    .map((source) => {
      const body = escapeRegExp(source);
      const prefix = /^[A-Za-z0-9]/.test(source) ? "(?<![A-Za-z0-9])" : "";
      const suffix = /[A-Za-z0-9]$/.test(source) ? "(?![A-Za-z0-9])" : "";
      return `${prefix}${body}${suffix}`;
    })
    .join("|");
  return new RegExp(alternation, "g");
}

const aliasMap = (entries: AliasEntry[]) => {
  const map = new Map<string, string>();
  for (const entry of validEntries(entries)) {
    const source = entry.source.trim();
    if (!map.has(source)) map.set(source, entry.alias.trim());
  }
  return map;
};

/** 把文本按原名切片，masked 段即替换后的化名，供预览高亮。 */
export function anonymizeParts(text: string, entries: AliasEntry[]): AnonPart[] {
  const pattern = buildPattern(entries);
  if (!pattern) return [{ value: text, masked: false }];
  const map = aliasMap(entries);
  const parts: AnonPart[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ value: text.slice(lastIndex, index), masked: false });
    parts.push({ value: map.get(match[0]) ?? match[0], masked: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ value: text.slice(lastIndex), masked: false });
  return parts;
}

export function anonymizeText(text: string, entries: AliasEntry[]): string {
  return anonymizeParts(text, entries)
    .map((part) => part.value)
    .join("");
}

function refsForSegments(project: ProjectData, predicate: (text: string) => boolean): SegmentRef[] {
  const refs: SegmentRef[] = [];
  for (const track of project.tracks) {
    track.segments.forEach((segment, index) => {
      if (predicate(segment.text)) {
        refs.push({
          trackId: track.id,
          trackName: track.name,
          segmentId: segment.id,
          index: index + 1,
          start: segment.start,
          end: segment.end,
        });
      }
    });
  }
  return refs;
}

/** 原名/化名在所有轨道正文里出现的片段。 */
export function findTextRefs(project: ProjectData, name: string): SegmentRef[] {
  if (!name) return [];
  return refsForSegments(project, (text) => text.includes(name));
}

/** 关联了某个标注（如人物标签）的片段。 */
function taggedRefs(project: ProjectData, tagId: string): SegmentRef[] {
  const refs: SegmentRef[] = [];
  for (const track of project.tracks) {
    track.segments.forEach((segment, index) => {
      if (segment.tagIds.includes(tagId)) {
        refs.push({
          trackId: track.id,
          trackName: track.name,
          segmentId: segment.id,
          index: index + 1,
          start: segment.start,
          end: segment.end,
        });
      }
    });
  }
  return refs;
}

/** 由某位发言人讲述的片段。 */
function speakerRefs(project: ProjectData, speakerId: string): SegmentRef[] {
  const refs: SegmentRef[] = [];
  for (const track of project.tracks) {
    track.segments.forEach((segment, index) => {
      if (segment.speakerId === speakerId) {
        refs.push({
          trackId: track.id,
          trackName: track.name,
          segmentId: segment.id,
          index: index + 1,
          start: segment.start,
          end: segment.end,
        });
      }
    });
  }
  return refs;
}

/**
 * 校验化名登记：
 * 1. 同一原名对应多个不同化名（无法确定导出时用哪个）；
 * 2. 化名撞上原文里另一个人物的名字（正文出现、发言人或“人物”标注同名）。
 * 片段引用跨全部轨道收集，因为化名在各条轨道间共用。
 */
export function validateAliases(project: ProjectData): AliasIssue[] {
  const entries = validEntries(project.aliases);
  const issues: AliasIssue[] = [];
  if (!entries.length) return issues;

  const groupBy = (key: (entry: AliasEntry) => string) => {
    const groups = new Map<string, AliasEntry[]>();
    for (const entry of entries) {
      const value = key(entry);
      const group = groups.get(value) ?? [];
      group.push(entry);
      groups.set(value, group);
    }
    return groups;
  };

  // 同一原名登记了两个（或更多）不同化名。
  for (const [source, group] of groupBy((entry) => entry.source.trim())) {
    const aliases = [...new Set(group.map((entry) => entry.alias.trim()))];
    if (aliases.length >= 2) {
      const refs = new Map<string, SegmentRef>();
      for (const ref of findTextRefs(project, source)) refs.set(`${ref.trackId}:${ref.segmentId}`, ref);
      // 正文可能以称谓（如“林师傅”）指代，但人物标注仍指向该原名。
      const personTag = project.tags.find((tag) => tag.type === "person" && tag.label.trim() === source);
      if (personTag) {
        for (const ref of taggedRefs(project, personTag.id)) refs.set(`${ref.trackId}:${ref.segmentId}`, ref);
      }
      issues.push({
        code: "duplicate-source",
        entryIds: group.map((entry) => entry.id),
        source,
        aliases,
        reasons: [],
        segments: [...refs.values()],
      });
    }
  }

  // 化名撞上原文里另一个人物的名字。
  for (const [alias, group] of groupBy((entry) => entry.alias.trim())) {
    const refs = new Map<string, SegmentRef>();
    const addRefs = (items: SegmentRef[]) => {
      for (const ref of items) refs.set(`${ref.trackId}:${ref.segmentId}`, ref);
    };
    const reasons: string[] = [];

    const textRefs = findTextRefs(project, alias);
    addRefs(textRefs);
    if (textRefs.length) reasons.unshift(`化名仍以原文人物身份出现在 ${textRefs.length} 个片段中`);

    const speaker = project.speakers.find((item) => item.name.trim() === alias);
    if (speaker) {
      reasons.push(`发言人名单中的「${speaker.name}」`);
      addRefs(speakerRefs(project, speaker.id));
    }

    const personTag = project.tags.find((tag) => tag.type === "person" && tag.label.trim() === alias);
    if (personTag) {
      reasons.push(`人物标注「${personTag.label}」`);
      addRefs(taggedRefs(project, personTag.id));
    }

    const otherSource = entries.find(
      (entry) => entry.source.trim() === alias && !group.some((item) => item.id === entry.id),
    );
    if (otherSource) reasons.push(`另一条登记要藏起的原名「${alias}」`);

    if (refs.size || otherSource) {
      issues.push({
        code: "alias-collision",
        entryIds: group.map((entry) => entry.id),
        alias,
        reasons,
        segments: [...refs.values()],
      });
    }
  }

  return issues;
}
