import { createSeedProject } from "../src/data";
import { anonymizeText, validateAliases, findTextRefs } from "../src/anonymize";
import type { ProjectData } from "../src/types";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
};

const project = createSeedProject();
project.aliases = [{ id: "a1", source: "林有德", alias: "林某" }];
check(
  "基本替换",
  anonymizeText("我爸爸叫林有德，他在船上做账房。", project.aliases),
  "我爸爸叫林某，他在船上做账房。",
);

// 同一原名多个化名
project.aliases = [
  { id: "a1", source: "林有德", alias: "林某" },
  { id: "a2", source: "林有德", alias: "林先生" },
];
let issues = validateAliases(project);
check("重复原名 -> duplicate-source 数量", issues.length, 1);
check("重复原名 code", issues[0].code, "duplicate-source");
check("重复原名 aliases", issues[0].aliases, ["林某", "林先生"]);
check("重复原名片段数(seg-3, seg-7)", issues[0].segments.length, 2);
check("片段定位轨道", issues[0].segments.map((r) => r.trackName), ["普通话校订轨", "普通话校订轨"]);
check("片段定位序号", issues[0].segments.map((r) => r.index), [3, 7]);

// 化名撞上原文里另一个人物（发言人 + 人物标注；“陈师傅”正文以“林师傅”指代，靠标注命中）
project.aliases = [{ id: "a1", source: "林有德", alias: "陈师傅" }];
issues = validateAliases(project);
check("撞名 -> alias-collision 数量", issues.length, 1);
check("撞名 code", issues[0].code, "alias-collision");
const reasonText = issues[0].reasons.join("；");
check("撞名原因含发言人", reasonText.includes("发言人名单中的「陈师傅」"), true);
check("撞名原因含人物标注", reasonText.includes("人物标注「陈师傅」"), true);
check("撞名片段含 seg-7（sp-chen 讲述）", issues[0].segments.map((r) => r.segmentId).includes("seg-7"), true);

// 化名与正文里真实出现的人物称谓重名（“林师傅”在 seg-7 正文出现）
project.aliases = [{ id: "a1", source: "林有德", alias: "林师傅" }];
issues = validateAliases(project);
const linReason = issues[0].reasons.join("；");
check("正文重名原因含片段数", /\d+ 个片段/.test(linReason), true);
check("正文重名命中 seg-7", issues[0].segments.map((r) => r.segmentId), ["seg-7"]);

// 化名是另一条登记的原名（链式遮蔽）
project.aliases = [
  { id: "a1", source: "林有德", alias: "陈师傅" },
  { id: "a2", source: "陈师傅", alias: "陈某" },
];
issues = validateAliases(project);
check("链式：冲突数量（a1 撞 a2 的原名 + a2 撞正文人物）", issues.length >= 1, true);
check(
  "单次扫描无连锁：林有德 -> 陈师傅，不被再次替换成陈某",
  anonymizeText("林有德与陈师傅", project.aliases),
  "陈师傅与陈某",
);

// 英文词边界
project.aliases = [{ id: "a1", source: "Lin", alias: "Mr. X" }];
check("英文词边界", anonymizeText("Lin and Lincoln spoke", project.aliases), "Mr. X and Lincoln spoke");

// 地名替换跨轨道共用
project.aliases = [{ id: "a1", source: "闽江", alias: "某江" }];
const refs = findTextRefs(project, "闽江");
check("地名只在 seg-3 出现", refs.map((r) => r.segmentId), ["seg-3"]);
check("无冲突时空结果", validateAliases({ ...project, aliases: [{ id: "a1", source: "闽江", alias: "某江" }] }).length, 0);

console.log(failures ? `\n${failures} 个失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
