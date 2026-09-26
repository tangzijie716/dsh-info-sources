/**
 * 验证插件包能被 profile 真实解析并 apply —— harness 加载 bundle 走的就是这条路径
 * （从 profile 目录解析包名 → 读 package.json 的 main → import → apply(ctx)）。
 *
 *   node test/bundle-resolution.mjs ["C:\Users\<you>\.dsh\profiles\web"]
 *
 * 默认 profile 目录是 web profile。只读，不写任何文件。
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const profileDir = process.argv[2] ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "profiles", "web");
console.log(`profile 目录：${profileDir}`);

const require = createRequire(join(profileDir, "noop.js"));
const entry = require.resolve("dsh-info-sources");
console.log(`解析到入口：${entry}`);

const mod = await import(pathToFileURL(entry).href);
if (typeof mod.apply !== "function") {
  console.error("✗ 包没有导出 apply —— cordis 插件入口不对");
  process.exit(1);
}

const registered = new Map();
mod.apply({ tools: { register(definition) { registered.set(definition.name, definition); return () => {}; } } });

const expected = ["info_sources", "info_fetch", "info_collect", "info_reload", "info_source_save"];
let failed = 0;
for (const name of expected) {
  const ok = registered.has(name);
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} apply(ctx) 注册了 ${name}`);
}

const reload = await registered.get("info_reload")?.execute({}, { signal: new AbortController().signal });
console.log(`✓ 源清单可用：${reload?.total} 个源（启用 ${reload?.enabledCount} 个），校验问题 ${reload?.issues?.length ?? 0} 条`);
console.log(`  内置清单：${reload?.builtin}`);

console.log(failed === 0 ? "\n结果：全部通过" : `\n结果：${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
