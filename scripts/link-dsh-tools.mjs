/**
 * 为本地开发建立 @deepseek-ai/dsh-tools 的解析链接。
 *
 *   node scripts/link-dsh-tools.mjs
 *
 * 为什么需要：以 `link:` 方式装进 profile 时，插件的真实路径在 profile 之外，
 * 插件里 `import "@deepseek-ai/dsh-tools"` 会从真实路径逐级向上找 node_modules，
 * 找不到 profile 下的解析锚点。harness 只用 profile 目录解析*入口*包名，
 * 包内部的 import 仍按 Node 常规语义走，所以在包内建一个指向 DSH 自带副本的
 * junction 就够了（Windows 下 junction 不需要管理员权限）。
 *
 * 从 npm/git 装进 profile 的包不需要这一步：它的物理位置就在
 * <profile>/node_modules 下，向上就能找到锚点。
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");

/** 候选目标：profile 锚点优先，其次 dsh 包内自带的副本 */
const candidates = [
  join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-tools"),
  join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-tools"),
];

const target = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
if (target === undefined) {
  console.error("找不到 DSH 自带的 @deepseek-ai/dsh-tools，试过：");
  for (const candidate of candidates) console.error(`  ${candidate}`);
  console.error("请确认 DSH 已安装，或用 DSH_HOME 指定其 home 目录。");
  process.exit(1);
}

const linkDir = join(packageRoot, "node_modules", "@deepseek-ai");
const linkPath = join(linkDir, "dsh-tools");
mkdirSync(linkDir, { recursive: true });

if (existsSync(join(linkPath, "package.json"))) {
  console.log(`已存在，跳过：${linkPath}`);
} else {
  if (existsSync(linkPath)) {
    const info = lstatSync(linkPath);
    if (info.isDirectory() || info.isSymbolicLink()) rmSync(linkPath, { recursive: true, force: true });
    else throw new Error(`目标路径已存在且不是目录：${linkPath}`);
  }
  symlinkSync(target, linkPath, "junction");
  console.log(`已建立 junction：${linkPath}`);
}
console.log(`  → ${target}`);
