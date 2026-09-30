/**
 * 采集结果落盘 —— 把「读出来的信息」默认写成一份 markdown，便于后续写作、归档与人工复核。
 *
 * 文件名：info_collection_<YYYYMMDDHHmmss>.md（北京时间）
 * 目录解析优先级：
 *   1. 调用时给的 path（以 .md 结尾视为文件名，否则视为目录；相对路径按会话工作区解析）
 *   2. 环境变量 $DSH_INFO_OUTPUT_DIR
 *   3. 会话工作区（调用方从 exec.agent.session.header.cwd 取出后传进来，见 lib/index.js）
 *   4. process.cwd()，仅在前三者都拿不到时兜底
 *
 * 注意 3 与 4 的区别：harness 可以在任意目录启动，而会话工作区是会话级设置，二者常常不同；
 * 写文件应落在会话工作区里，而不是进程启动目录。
 *
 * 自动生成的文件名从不覆盖已有文件：撞名（同一秒内多次采集）会退让成 _2、_3……
 * 显式指定 .md 文件路径时按调用方意图覆盖。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const TIME_ZONE = "Asia/Shanghai";
const FILE_PREFIX = "info_collection_";

/** 北京时间字段（hourCycle 固定 h23，避免午夜出现 24 点） */
function timeParts(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/** 文件名时间戳：YYYYMMDDHHmmss（北京时间） */
export function fileStamp(date = new Date()) {
  const parts = timeParts(date);
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

/** 人读时间：YYYY/MM/DD HH:mm:ss（北京时间） */
function displayTime(date = new Date()) {
  const parts = timeParts(date);
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** 短时间：MM-DD HH:mm（北京时间）；解析不了就原样返回 */
function shortTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? "");
  const parts = timeParts(date);
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * 解析输出位置。
 * @param options.path    调用方给的目录或 .md 文件路径（相对路径按 baseDir 解析）
 * @param options.baseDir 会话工作区（exec.agent.session.header.cwd）
 * @param options.now     取文件名时间戳用的时刻
 * @returns {{ file: string, dir: string, generated: boolean }}
 */
export function resolveOutput({ path, baseDir, now = new Date() } = {}) {
  const base = typeof baseDir === "string" && baseDir.trim() !== "" ? resolve(baseDir) : process.cwd();
  const explicit = typeof path === "string" ? path.trim() : "";
  if (explicit !== "") {
    const absolute = isAbsolute(explicit) ? explicit : resolve(base, explicit);
    if (absolute.toLowerCase().endsWith(".md")) return { file: absolute, dir: dirname(absolute), generated: false };
    return { file: join(absolute, `${FILE_PREFIX}${fileStamp(now)}.md`), dir: absolute, generated: true };
  }
  const envDir = typeof process.env.DSH_INFO_OUTPUT_DIR === "string" ? process.env.DSH_INFO_OUTPUT_DIR.trim() : "";
  const dir = envDir === "" ? base : resolve(envDir);
  return { file: join(dir, `${FILE_PREFIX}${fileStamp(now)}.md`), dir, generated: true };
}

/** 落盘：自动命名的用 wx 独占创建，撞名就退让；显式 .md 路径直接覆盖 */
function writeResolved(target, content) {
  mkdirSync(target.dir, { recursive: true });
  if (!target.generated) {
    writeFileSync(target.file, content, "utf8");
    return target.file;
  }
  const base = target.file.replace(/\.md$/i, "");
  for (let attempt = 1; attempt <= 100; attempt++) {
    const candidate = attempt === 1 ? target.file : `${base}_${attempt}.md`;
    try {
      writeFileSync(candidate, content, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`同名文件过多，无法写入：${target.file}`);
}

/** 一条条目 → markdown 小节 */
function itemBlock(item, index, labelOf) {
  const lines = [`### ${String(index + 1).padStart(2, "0")}. ${item.title}`, ""];
  const facts = [];
  if (item.rank !== undefined) facts.push(`**名次**：${item.rank}`);
  if (typeof item.hot === "number") facts.push(`**热度**：${item.hot}`);
  if (item.label !== undefined) facts.push(`**分类**：${item.label}`);
  if (facts.length > 0) lines.push(facts.join(" ｜ "), "");
  // 采集源（feed）——与「出处（媒体）」是两回事：一个采集源里混着很多媒体。
  // 覆盖度统计（rules/select-topic.md §0.1）要的正是这一维，故必须落盘。
  if (item.sourceId !== undefined) {
    lines.push(`- **来源**：${labelOf?.get(item.sourceId) ?? item.sourceId}（\`${item.sourceId}\`）`);
  }
  if (item.origin !== undefined) lines.push(`- **出处**：${item.origin}`);
  if (item.publishedAt !== undefined) {
    lines.push(`- **发布**：${item.publishedAt}（北京时间 ${shortTime(item.publishedAt)}）`);
  }
  if (item.originalUrl !== undefined) lines.push(`- **原文**：${item.originalUrl}`);
  if (item.url !== undefined) lines.push(`- **站内**：${item.url}`);
  // alsoFrom 里装的是**其余采集源的 sourceId**（dedupeByTitle 合并时写入），
  // 所以这一行要同时给出 id 与名字：只有名字对不上源清单，只有 id 人读不便。
  if (item.alsoFrom !== undefined && item.alsoFrom.length > 0) {
    lines.push(`- **同题还见于**：${item.alsoFrom.map((id) => {
      const name = labelOf?.get(id);
      return name === undefined ? id : `${name}（\`${id}\`）`;
    }).join("、")}`);
  }
  if (item.summary !== undefined) lines.push("", `**摘要**：${item.summary}`);
  // 同一个采集源自己发重的副本。与 alsoFrom 分开：那是"别的源也报了"，这是"同源自报重了"。
  const dup = duplicatesOf(item);
  if (dup.length > 0) {
    lines.push(`- **同源重复**：${dup.length} 条（\`${item.sourceId}\`）`);
  }
  return lines;
}

/**
 * 条目的同源重复副本数。
 *
 * 既认合并结果上的 `duplicates` 数组，也认按源预聚合好的 `duplicates` 计数——
 * 两种都支持，是为了让「按条渲染」与「按源汇总」两条路径不必各自算一遍。
 * @param item - 一条条目。
 * @returns 重复副本的 sourceId 数组。
 */
function duplicatesOf(item) {
  if (Array.isArray(item.duplicates)) return item.duplicates;
  if (typeof item.duplicates === "number" && item.duplicates > 0) {
    return Array.from({ length: item.duplicates }, () => item.sourceId);
  }
  return [];
}

/**
 * 判断某个源在最终落盘结果里是不是「一条都没留下」。
 *
 * 注意不能用 `duplicatesBySource.get(id) ?? 0 === 0`：Map 里没有这个键时含义是
 * "调用方没给汇总"，与"这个源确实 0 条"是两回事，混起来会把正常结果误报成丢光。
 * @param duplicatesBySource - 按源汇总的落盘条数；未提供时为 undefined。
 * @param sourceId - 源 id。
 * @returns 是否确实被去重成 0 条。
 */
function isFullyDeduped(duplicatesBySource, sourceId) {
  if (duplicatesBySource === undefined) return false;
  if (typeof duplicatesBySource.get !== "function") return false;
  return !duplicatesBySource.has(sourceId) || duplicatesBySource.get(sourceId) === 0;
}

/**
 * 组装并写入一份采集结果 markdown。
 * @param options.heading   一级标题
 * @param options.metaLines 标题下引用块里的附加说明
 * @param options.sources   源结果数组 [{ sourceId, label?, ok, count, url?, matchedPath?, error? }]
 * @param options.items     条目数组；每条须带 sourceId（会渲染成「**来源**」），
 *                          合并过的条目用 alsoFrom 记其余 sourceId（渲染成「**同题还见于**」），
 *                          同源重复副本用 duplicates 记（渲染成「**同源重复**」）
 * @param options.labelOf   Map<sourceId, label>，用于渲染「来源」与 alsoFrom
 * @param options.duplicatesBySource  Map<sourceId, 落盘条数>；给了就在「来源」小节同时显示
 *                          「自报 / 落盘」两个数——每个源 count 是**全局去重前**的条数，二者会不等
 * @param options.path      目录或 .md 文件路径
 * @param options.baseDir   会话工作区，缺省落盘目录与相对路径的解析基准
 * @param options.now       时间戳
 * @returns {{ file: string, dir: string, bytes: number, itemCount: number, generated: boolean }}
 */
export function writeCollection({ heading, metaLines = [], sources = [], items = [], labelOf, duplicatesBySource, path, baseDir, now = new Date() }) {
  const target = resolveOutput({ path, baseDir, now });
  const lines = [
    `# ${heading}`,
    "",
    `> 抓取时间：${displayTime(now)}（北京时间）`,
    `> 条目：${items.length} 条`,
  ];
  for (const line of metaLines) lines.push(`> ${line}`);
  lines.push("");

  if (sources.length > 0) {
    lines.push("## 来源", "");
    for (const source of sources) {
      const label = labelOf?.get(source.sourceId) ?? source.label ?? source.sourceId;
      // count 是全局去重前的条数；去重会把同源重复副本并掉，于是落盘条数可能更少。
      // 两个数都给出来，差额才看得见——只给一个数时，一条源自报 20、正文 19 是没有痕迹的。
      let outcome = source.ok === true ? `${source.count} 条` : (source.error ?? "失败");
      if (source.ok === true && duplicatesBySource !== undefined && typeof duplicatesBySource.get === "function") {
        const retained = duplicatesBySource.get(source.sourceId) ?? 0;
        if (retained !== source.count) {
          outcome += `（去重后落盘 ${retained} 条${retained === 0 ? "，全部为重复副本" : ""}）`;
        }
      }
      lines.push(`- ${source.ok === true ? "✓" : "✗"} **${label}**（\`${source.sourceId}\`）：${outcome}`);
      if (source.url !== undefined) lines.push(`  - 请求：${source.url}`);
      if (typeof source.matchedPath === "string" && source.matchedPath !== "") {
        lines.push(`  - 命中字段路径：\`${source.matchedPath}\``);
      }
      if (isFullyDeduped(duplicatesBySource, source.sourceId)) {
        lines.push(`  - ⚠ 本源的条目全部与其它源重复，正文里没有以它为主源的条目`);
      }
    }
    lines.push("");
  }

  lines.push(`## 条目（${items.length} 条）`, "");
  if (items.length === 0) lines.push("（本次没有取到条目）", "");
  for (const [index, item] of items.entries()) lines.push(...itemBlock(item, index, labelOf), "");

  const content = `${lines.join("\n")}\n`;
  const file = writeResolved(target, content);
  return { file, dir: target.dir, bytes: Buffer.byteLength(content, "utf8"), itemCount: items.length, generated: target.generated };
}
