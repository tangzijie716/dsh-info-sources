/**
 * 把任意一个源整份导出成 markdown 快照。
 *
 *   node test/dump-source.mjs <源id> [输出文件路径] [JSON 入参]
 *
 * 做法：用一份临时覆盖层把该源的条数上限放开（默认层里的 limit 只是常规取数用的），
 * 然后调 info_fetch，用显式 .md 路径落盘 —— 写出来的就是插件自己的落盘格式，
 * 只是换成了好认的文件名。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const sourceId = process.argv[2];
if (sourceId === undefined) {
  console.error("用法：node test/dump-source.mjs <源id> [输出文件路径] [JSON 入参]");
  process.exit(2);
}
const stamp = new Date().toISOString().slice(0, 10);
const outPath = resolve(process.argv[3] ?? join(packageRoot, "..", `${sourceId}-全量-${stamp}.md`));
const extraArgs = process.argv[4] === undefined ? {} : JSON.parse(process.argv[4]);

// ── 加载插件（按 profile 解析路径，和 harness 一致）────────────────────────
const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "profiles", "web");
let entry;
try {
  entry = createRequire(join(profileDir, "noop.js")).resolve("dsh-info-sources");
} catch {
  entry = pathToFileURL(join(packageRoot, "lib", "index.js")).href;
}
const mod = await import(pathToFileURL(entry).href);
const registered = new Map();
mod.apply({ tools: { register(definition) { registered.set(definition.name, definition); return () => {}; } } });

// ── 临时覆盖层：只放开条数上限，其余字段沿用默认层 ────────────────────────
const tempDir = mkdtempSync(join(tmpdir(), "dsh-dump-source-"));
const overridePath = join(tempDir, "info-sources.json");
writeFileSync(overridePath, `${JSON.stringify({
  version: 1,
  _comment: "dump-source 临时覆盖层：只放开条数上限",
  sources: [{ id: sourceId, limit: 0 }],
}, null, 2)}\n`, "utf8");
const result = await registered.get("info_fetch").execute(
  { id: sourceId, sourcesPath: overridePath, path: outPath, limit: 0, ...extraArgs },
  { signal: new AbortController().signal },
);

if (result.ok !== true) {
  console.error(`抓取失败：${result.error}`);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
}

const body = readFileSync(outPath, "utf8");
const summaryLengths = result.items.filter((item) => item.summary !== undefined).map((item) => item.summary.length);
const withSummary = summaryLengths.length;
console.log(`源：${result.label}（${sourceId}，${result.method}）`);
console.log(`请求：${result.url}`);
console.log(`条目：${result.count} 条（归一化前 ${result.rawCount}）`);
console.log(`带摘要：${withSummary} 条，摘要长度 平均 ${Math.round(summaryLengths.reduce((a, b) => a + b, 0) / (withSummary || 1))} / 最长 ${Math.max(0, ...summaryLengths)} 字符`);
console.log(`带出处：${result.items.filter((item) => item.origin !== undefined).length} 条，带发布时间：${result.items.filter((item) => item.publishedAt !== undefined).length} 条`);
console.log(`文件：${outPath}（${statSync(outPath).size} 字节，${body.split("\n").length} 行）`);
rmSync(tempDir, { recursive: true, force: true });
