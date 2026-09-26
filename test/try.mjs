/**
 * 手动试跑单个工具 —— 不启动 harness，按 profile 的真实解析路径加载插件后调用。
 *
 *   node test/try.mjs info_sources '{}'
 *   node test/try.mjs info_fetch '{"id":"baidu-hot","limit":10}'
 *   node test/try.mjs info_collect '{"ids":"baidu-hot,toutiao-hot","dedupe":"title","sort":"hot","limit":10}'
 *
 * 第二参数是工具的 JSON 入参。输出先渲染成给人看的文本，再附原始 JSON。
 * PowerShell 会吃掉内层引号，这时可以改用环境变量传参：
 *   $env:INFO_ARGS='{"id":"baidu-hot","limit":10}'; node test/try.mjs info_fetch
 *
 * 注意：info_fetch / info_collect 默认会落盘（info_collection_<时间戳>.md），
 * 位置取「会话工作区」——harness 里来自 exec.agent.session.header.cwd，
 * 这个脚本用 $env:DSH_WORKSPACE 模拟它（不设则退回 process.cwd()），
 * 也可以用入参里的 path / save=false 覆盖。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [, , toolName = "info_sources", argvArgs] = process.argv;

let rawArgs = argvArgs ?? process.env.INFO_ARGS ?? "{}";
if (rawArgs.startsWith("@")) rawArgs = readFileSync(rawArgs.slice(1), "utf8");

let args;
try {
  args = JSON.parse(rawArgs);
} catch (error) {
  console.error(`入参必须是 JSON 对象：${String(error?.message ?? error)}\n收到：${rawArgs}`);
  process.exit(2);
}

// 优先按 profile 的解析路径加载（= harness 加载 bundle 的方式），失败则退回本地包
const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "profiles", "web");

let entry;
try {
  entry = createRequire(join(profileDir, "noop.js")).resolve("dsh-info-sources");
} catch {
  entry = new URL("../lib/index.js", import.meta.url).pathname;
  console.error(`（profile 目录解析失败，改用本地包：${profileDir}）`);
}

const mod = await import(pathToFileURL(entry).href);
const registered = new Map();
mod.apply({ tools: { register(definition) { registered.set(definition.name, definition); return () => {}; } } });

const tool = registered.get(toolName);
if (tool === undefined) {
  console.error(`没有这个工具：${toolName}；可用：${[...registered.keys()].join(", ")}`);
  process.exit(2);
}

// 模拟 harness 的调用上下文：会话工作区走 exec.agent.session.header.cwd
const sessionCwd = process.env.DSH_WORKSPACE?.trim() || process.cwd();
const value = await tool.execute(args, {
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: sessionCwd } } },
});
console.log(tool.output.render(args, value)[0].text);
console.log("\n--- 原始 JSON ---");
console.log(JSON.stringify(value, null, 2));
