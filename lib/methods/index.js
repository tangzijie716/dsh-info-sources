/**
 * 采集方式注册表 —— 源清单里的 `method` 字符串在这里查适配器。
 *
 * 加一种采集方式 = 在 lib/methods/ 下加一个同形状的文件，然后在这里 register 一行；
 * 工具层（lib/index.js）与清单层（config/sources.json）都不用改。
 * 已实现：api-get（JSON 接口）、rss（RSS/Atom/RDF 订阅源）。
 * 预留：html（选择器抽列表/正文）、api-post（POST + body）。
 */
import { apiGet } from "./api-get.js";
import { rss } from "./rss.js";

const adapters = new Map();

/** 注册/替换一个方式适配器（也允许第三方插件在 apply 里注册自己的方式） */
function registerMethod(adapter) {
  if (adapter === null || typeof adapter !== "object") throw new TypeError("registerMethod(adapter)：需要一个适配器对象");
  const { id, label, summary, run, requiredKeys } = adapter;
  if (typeof id !== "string" || id.trim() === "") throw new TypeError("registerMethod(adapter)：adapter.id 必须是非空字符串");
  if (typeof run !== "function") throw new TypeError(`registerMethod(${id})：adapter.run 必须是函数`);
  adapters.set(id, {
    id,
    label: typeof label === "string" ? label : id,
    summary: typeof summary === "string" ? summary : "",
    requiredKeys: Array.isArray(requiredKeys) ? requiredKeys : [],
    run,
  });
  return () => adapters.delete(id);
}

/** 按 id 取适配器；不存在返回 undefined */
export function getMethod(id) {
  return adapters.get(id);
}

/** 全部已注册方式的简介，供 info_sources 展示与校验报错提示 */
export function listMethods() {
  return [...adapters.values()].map(({ id, label, summary, requiredKeys }) => ({ id, label, summary, requiredKeys }));
}

registerMethod(apiGet);
registerMethod(rss);
