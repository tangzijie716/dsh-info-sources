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
  if (item.origin !== undefined) lines.push(`- **出处**：${item.origin}`);
  if (item.publishedAt !== undefined) {
    lines.push(`- **发布**：${item.publishedAt}（北京时间 ${shortTime(item.publishedAt)}）`);
  }
  if (item.originalUrl !== undefined) lines.push(`- **原文**：${item.originalUrl}`);
  if (item.url !== undefined) lines.push(`- **站内**：${item.url}`);
  if (item.alsoFrom !== undefined && item.alsoFrom.length > 0) {
    lines.push(`- **同题还见于**：${item.alsoFrom.map((id) => labelOf?.get(id) ?? id).join("、")}`);
  }
  if (item.summary !== undefined) lines.push("", `**摘要**：${item.summary}`);
  return lines;
}

/**
 * 组装并写入一份采集结果 markdown。
 * @param options.heading   一级标题
 * @param options.metaLines 标题下引用块里的附加说明
 * @param options.sources   源结果数组 [{ sourceId, label?, ok, count, url?, matchedPath?, error? }]
 * @param options.items     条目数组
 * @param options.labelOf   Map<sourceId, label>，用于渲染 alsoFrom
 * @param options.path      目录或 .md 文件路径
 * @param options.baseDir   会话工作区，缺省落盘目录与相对路径的解析基准
 * @param options.now       时间戳
 * @returns {{ file: string, dir: string, bytes: number, itemCount: number, generated: boolean }}
 */
export function writeCollection({ heading, metaLines = [], sources = [], items = [], labelOf, path, baseDir, now = new Date() }) {
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
      const outcome = source.ok === true ? `${source.count} 条` : (source.error ?? "失败");
      lines.push(`- ${source.ok === true ? "✓" : "✗"} **${label}**（\`${source.sourceId}\`）：${outcome}`);
      if (source.url !== undefined) lines.push(`  - 请求：${source.url}`);
      if (typeof source.matchedPath === "string" && source.matchedPath !== "") {
        lines.push(`  - 命中字段路径：\`${source.matchedPath}\``);
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
