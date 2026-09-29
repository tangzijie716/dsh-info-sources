/**
 * dsh-info-sources —— 信息采集插件（Host 侧）。
 *
 * 设计要点：
 *   1. 采集方式与源清单解耦：工具层只做「选源 → 调适配器 → 归一化 → 汇总」，
 *      具体怎么取数在 lib/methods/ 下的适配器里，取哪些地址在 config/sources.json
 *      （以及用户覆盖层的 info-sources.json）里。改地址不动代码，加方式不动工具。
 *   2. 所有工具都返回结构化结果（ok/error 字段），抓取失败是「正常结果」而不是抛异常，
 *      便于模型自己决定重试、换源或降级。
 *   3. 清单可热重载：info_reload 或文件 mtime 变化后自动生效，不必重启 harness。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isAbsolute, resolve } from "node:path";
import { getMethod } from "./methods/index.js";
import { writeCollection } from "./output.js";
import { loadRegistry, saveUserSource } from "./registry.js";

export const inject = ["tools"];

const TOOL_TIMEOUT_MS = 60000;

const sourcesPathParameter = {
  sourcesPath: {
    type: "string",
    description: "本次调用使用的用户覆盖层 JSON 路径；不传则只使用包内默认源。相对路径按会话工作区解析。",
  },
};

// ── 输出 schema 片段（DSH 的 schema DSL；object 必须显式 additionalProperties）────

/** 统一条目：所有采集方式都归一到这个形状 */
const itemSpec = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    sourceId: { type: "string", required: true },
    title: { type: "string", required: true },
    rank: { type: "integer", required: true },
    hot: { type: "number" },
    url: { type: "string" },
    originalUrl: { type: "string" },
    origin: { type: "string" },
    publishedAt: { type: "string" },
    summary: { type: "string" },
    label: { type: "string" },
    alsoFrom: { type: "array", items: { type: "string" } },
  },
});

const issueSpec = () => ({
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    level: { type: "string", required: true },
    message: { type: "string", required: true },
  },
});

const text = (lines) => [{ type: "text", text: lines.filter((line) => line !== undefined).join("\n") }];

/** 渲染用：数值热度加千分位，缺失则不出热度 */
function hotText(item) {
  if (typeof item.hot !== "number") return "";
  return ` · 热度 ${item.hot.toLocaleString("en-US")}`;
}

/** ISO 时间 → 北京时间 MM-DD HH:mm；解析不了就原样返回 */
function timeText(iso) {
  if (typeof iso !== "string" || iso === "") return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

/** 条目的旁注：出处 / 标签 / 时间 / 同题出现的其它源 */
function itemExtras(item, labelOf) {
  const parts = [];
  if (item.origin !== undefined) parts.push(item.origin);
  if (item.label !== undefined) parts.push(item.label);
  const time = timeText(item.publishedAt);
  if (time !== undefined) parts.push(time);
  if (item.alsoFrom !== undefined && item.alsoFrom.length > 0) {
    parts.push(`也见于 ${item.alsoFrom.map((id) => labelOf?.get(id) ?? id).join("/")}`);
  }
  return parts.length === 0 ? "" : `（${parts.join("，")}）`;
}

/** 摘要行：有才输出，过长截断（原始值仍在结构化结果里） */
function summaryLine(item, indent = "    ") {
  if (item.summary === undefined) return undefined;
  const text = item.summary.length > 500 ? `${item.summary.slice(0, 500)}…` : item.summary;
  return `${indent}摘要：${text}`;
}

/** 链接行：优先给原文（便于核对），没有原文才给站内/主链接 */
function linkLine(item, indent = "    ") {
  if (item.originalUrl !== undefined) {
    return item.url === undefined
      ? `${indent}原文：${item.originalUrl}`
      : `${indent}原文：${item.originalUrl}　站内：${item.url}`;
  }
  if (item.url !== undefined) return `${indent}链接：${item.url}`;
  return undefined;
}

function sourceLine(source) {
  const state = source.enabled ? (source.ok ? "✓" : "✗") : "–";
  const mark = source.origin === "user" ? "*" : " ";
  const url = source.url === undefined ? "" : ` ${source.url}`;
  const limit = source.limit === undefined ? "" : ` limit=${source.limit}`;
  return `${state}${mark} ${source.id}  [${source.method}]  ${source.label}${limit}${url}`;
}

// ── 采集编排 ──────────────────────────────────────────────────────────────

/** 按 ids / tag 选出要采的源；返回 { selected, unknownIds } */
function selectSources(registry, { ids, tag, includeDisabled }) {
  const unknownIds = [];
  let pool = registry.sources;
  if (Array.isArray(ids) && ids.length > 0) {
    const byId = new Map(pool.map((source) => [source.id, source]));
    const selected = [];
    for (const id of ids) {
      const source = byId.get(id);
      if (source === undefined) unknownIds.push(id);
      else selected.push(source);
    }
    return { selected, unknownIds };
  }
  if (tag !== undefined && tag !== "") pool = pool.filter((source) => source.tags.includes(tag));
  return { selected: pool.filter((source) => includeDisabled || source.enabled), unknownIds };
}

/** 标题归一化，用于 dedupe="title" */
function normalizeTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[#＃]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 并行采集一组源，返回 { results, items }。
 * defaults 必须传下去：适配器的 limit / timeoutMs / headers 兜底都读它，
 * 漏了就会让「清单 defaults.limit」在 info_collect 路径上静默失效（源自己没写 limit 时完全不收口）。
 */
async function collect(sources, { signal, params, defaults }) {
  const outcomes = await Promise.all(sources.map(async (source) => {
    if (source.ok === false) {
      return {
        sourceId: source.id,
        label: source.label,
        ok: false,
        count: 0,
        error: `源配置校验未通过：${source.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join("；")}`,
        items: [],
      };
    }
    const method = getMethod(source.method);
    if (method === undefined) {
      return { sourceId: source.id, label: source.label, ok: false, count: 0, error: `method "${source.method}" 没有对应适配器`, items: [] };
    }
    try {
      const result = await method.run(source, { signal, params, defaults });
      return {
        sourceId: source.id,
        label: source.label,
        ok: result.ok === true,
        count: Array.isArray(result.items) ? result.items.length : 0,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.url === undefined ? {} : { url: result.url }),
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.matchedPath === undefined ? {} : { matchedPath: result.matchedPath }),
        ...(result.rawCount === undefined ? {} : { rawCount: result.rawCount }),
        items: Array.isArray(result.items) ? result.items : [],
      };
    } catch (error) {
      return { sourceId: source.id, label: source.label, ok: false, count: 0, error: `适配器异常：${String(error?.message ?? error)}`, items: [] };
    }
  }));
  return { results: outcomes, items: outcomes.flatMap((outcome) => outcome.items) };
}

/** dedupe="title"：同标题合并，保留热度最高（同热度取先出现）的一条，其余源记进 alsoFrom */
function dedupeByTitle(items) {
  const firstSeen = new Map();
  const merged = [];
  for (const item of items) {
    const key = normalizeTitle(item.title);
    const existingIndex = firstSeen.get(key);
    if (existingIndex === undefined) {
      firstSeen.set(key, merged.length);
      merged.push({ ...item });
      continue;
    }
    const existing = merged[existingIndex];
    const existingHot = typeof existing.hot === "number" ? existing.hot : Number.NEGATIVE_INFINITY;
    const candidateHot = typeof item.hot === "number" ? item.hot : Number.NEGATIVE_INFINITY;
    if (candidateHot > existingHot) {
      const alsoFrom = [...new Set([...(item.alsoFrom ?? []), existing.sourceId, ...(existing.alsoFrom ?? [])])]
        .filter((id) => id !== item.sourceId);
      merged[existingIndex] = { ...item, ...(alsoFrom.length === 0 ? {} : { alsoFrom }) };
    } else {
      existing.alsoFrom = [...new Set([...(existing.alsoFrom ?? []), item.sourceId, ...(item.alsoFrom ?? [])])]
        .filter((id) => id !== existing.sourceId);
    }
  }
  return merged;
}

/** sort="hot"：热度降序，没有热度的排最后；同热度按源内名次 */
function sortByHot(items) {
  return [...items].sort((a, b) => {
    const hotA = typeof a.hot === "number" ? a.hot : Number.NEGATIVE_INFINITY;
    const hotB = typeof b.hot === "number" ? b.hot : Number.NEGATIVE_INFINITY;
    if (hotA !== hotB) return hotB - hotA;
    return a.rank - b.rank;
  });
}

/** 逗号分隔的 id 串或数组 → 去重后的 id 数组 */
function toIdList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

/** 参数里的 params / patch 用 json 类型接收，这里做一次运行时收口 */
function asPlainObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value;
}

/** 两个取数工具共用的落盘参数说明 */
const saveParameters = {
  path: {
    type: "string",
    description: "落盘位置：目录，或直接给一个 .md 文件路径（相对路径按会话工作区解析）。缺省 = $DSH_INFO_OUTPUT_DIR，再缺省 = 会话工作区根目录",
  },
  save: {
    type: "boolean",
    description: "是否落盘，默认 true。文件名 info_collection_<YYYYMMDDHHmmss>.md，已存在则退让为 _2、_3…",
  },
};

/** 两个工具共用的输出 schema 片段 */
const saveProperties = {
  file: { type: "string" },
  fileBytes: { type: "integer" },
  fileError: { type: "string" },
};

/**
 * 会话工作区。harness 可以在任意目录启动，而会话工作区是会话级设置，二者常常不同；
 * 写文件应落在会话工作区里。取值与内置 pwsh 工具同源：exec.agent.session.header.cwd。
 */
function sessionDir(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : undefined;
}

function requestedSourcesPath(args, exec) {
  const value = typeof args?.sourcesPath === "string" ? args.sourcesPath.trim() : "";
  if (value === "") return undefined;
  if (isAbsolute(value)) return value;
  return resolve(sessionDir(exec) ?? process.cwd(), value);
}

/**
 * 落盘（默认开）。落盘失败不影响取数结果，只把原因记进 fileError。
 * @returns {{ file?, fileBytes?, fileError? }}
 */
function saveCollection(args, { heading, metaLines = [], sources = [], items, labelOf, baseDir }) {
  if (args.save === false) return {};
  try {
    const written = writeCollection({
      heading,
      metaLines,
      sources,
      items,
      labelOf,
      path: typeof args.path === "string" ? args.path : undefined,
      baseDir,
    });
    return { file: written.file, fileBytes: written.bytes };
  } catch (error) {
    return { fileError: String(error?.message ?? error) };
  }
}

/** 落盘结果 → 渲染行（放在结果最前面，长列表也不会把它埋掉） */
function fileLine(value) {
  if (value.file !== undefined) {
    return `已落盘：${value.file}（${value.fileBytes ?? 0} 字节）`;
  }
  if (value.fileError !== undefined) return `落盘失败：${value.fileError}`;
  return undefined;
}

// ── 插件 ──────────────────────────────────────────────────────────────────
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "info_sources",
    description:
      "列出信息采集清单里的所有源（id / 采集方式 / 是否启用 / 接口地址 / 标签 / 校验问题）。"
      + "清单始终包含包内 config/sources.json；只有本次显式传入 sourcesPath 时才叠加用户覆盖文件。"
      + "先调用它拿到可用 id，再用 info_fetch 或 info_collect 取数。",
    parameters: {
      ...sourcesPathParameter,
      tag: { type: "string", description: "只看某个标签的源，例如 hot / news / dev" },
      includeDisabled: { type: "boolean", description: "是否包含 enabled=false 的源，默认 false" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          builtin: { type: "string", required: true },
          user: { type: "string" },
          userExists: { type: "boolean", required: true },
          loadedAt: { type: "string", required: true },
          total: { type: "integer", required: true },
          enabledCount: { type: "integer", required: true },
          commentedOut: { type: "array", required: true, items: { type: "string" } },
          methods: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                label: { type: "string", required: true },
                summary: { type: "string", required: true },
              },
            },
          },
          sources: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                label: { type: "string", required: true },
                method: { type: "string", required: true },
                enabled: { type: "boolean", required: true },
                origin: { type: "string", required: true },
                ok: { type: "boolean", required: true },
                url: { type: "string" },
                note: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                overrides: { type: "array", items: { type: "string" } },
                envMissing: { type: "array", items: { type: "string" } },
                limit: { type: "number" },
                timeoutMs: { type: "number" },
                issues: { type: "array", items: issueSpec() },
              },
            },
          },
          issues: { type: "array", required: true, items: issueSpec() },
        },
      },
      render: (args, value) => {
        const lines = [
          `清单：内置 ${value.builtin}`,
          value.userExists ? `覆盖层 ${value.user}` : "覆盖层：本次未使用",
          `源 ${value.total} 个，启用 ${value.enabledCount} 个；采集方式：`
          + value.methods.map((method) => `${method.id}（${method.label}）`).join("、"),
          "",
        ];
        for (const source of value.sources) {
          lines.push(sourceLine(source));
          if (source.note !== undefined) lines.push(`     备注：${source.note}`);
          if (source.tags !== undefined && source.tags.length > 0) lines.push(`     标签：${source.tags.join(", ")}`);
          if (source.overrides !== undefined && source.overrides.length > 0) lines.push(`     被覆盖层改写：${source.overrides.join(", ")}`);
          if (source.envMissing !== undefined && source.envMissing.length > 0) lines.push(`     环境变量：${source.envMissing.join(", ")}`);
          for (const issue of source.issues ?? []) lines.push(`     [${issue.level}] ${issue.message}`);
        }
        const orphans = value.issues.filter((issue) => issue.id === "(defaults)");
        for (const issue of orphans) lines.push(`[${issue.level}] defaults.${issue.message}`);
        if (value.commentedOut.length > 0) {
          lines.push("", `另有 ${value.commentedOut.length} 个源被注释掉（清单里的 _disabled 块，未删除）：${value.commentedOut.join(", ")}`);
        }
        lines.push("", "标记：✓ 可用，✗ 有校验错误，– 已停用；行首 * 表示该源被覆盖层改写。");
        return text(lines);
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: "generic", title: "查看信息源清单", kind: "info", rawInput: args.tag ?? "all" }),
    async execute(args, exec) {
      const registry = loadRegistry({ userPath: requestedSourcesPath(args, exec) });
      const tag = typeof args.tag === "string" && args.tag.trim() !== "" ? args.tag.trim() : undefined;
      const includeDisabled = args.includeDisabled === true;
      const sources = registry.sources
        .filter((source) => (includeDisabled || source.enabled))
        .filter((source) => (tag === undefined ? true : source.tags.includes(tag)))
        .map((source) => ({
          id: source.id,
          label: source.label,
          method: source.method,
          enabled: source.enabled,
          origin: source.origin,
          ok: source.ok,
          ...(typeof source.url === "string" ? { url: source.url } : {}),
          ...(typeof source.note === "string" ? { note: source.note } : {}),
          ...(source.tags.length > 0 ? { tags: source.tags } : {}),
          ...(Array.isArray(source.overrides) && source.overrides.length > 0 ? { overrides: source.overrides } : {}),
          ...(Array.isArray(source.envMissing) && source.envMissing.length > 0
            ? { envMissing: source.envMissing.map((miss) => `${miss.name}${miss.optional ? "（可选）" : ""}`) }
            : {}),
          ...(Number.isFinite(Number(source.limit)) ? { limit: Number(source.limit) } : {}),
          ...(Number.isFinite(Number(source.timeoutMs)) ? { timeoutMs: Number(source.timeoutMs) } : {}),
          ...(source.issues.length > 0
            ? { issues: source.issues.map((issue) => ({ level: issue.level, message: issue.message })) }
            : {}),
        }));
      return {
        builtin: registry.paths.builtin,
        ...(registry.paths.user === undefined ? {} : { user: registry.paths.user }),
        userExists: registry.paths.userExists,
        loadedAt: registry.loadedAt,
        total: sources.length,
        enabledCount: sources.filter((source) => source.enabled).length,
        commentedOut: registry.commentedOut,
        methods: registry.methods.map((method) => ({ id: method.id, label: method.label, summary: method.summary })),
        sources,
        issues: registry.issues.map((issue) => ({ id: issue.id, level: issue.level, message: issue.message })),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "info_fetch",
    description:
      "按 id 从清单里的某一个源取数（默认方式是 api-get：HTTP GET 一个 JSON 接口并归一化）。"
      + "接口地址、请求头、查询参数、字段映射全在清单里维护，调用时可以用 params 追加/覆盖查询参数。"
      + "条目统一返回标题、名次，以及源里有的热度、摘要、出处、原文链接与发布时间。"
      + "取到的信息默认会落盘成一份 markdown（info_collection_<时间戳>.md，默认放工作区根目录），"
      + "用 path 指定目录或文件，用 save=false 关闭。"
      + "抓取失败不抛异常，返回 ok=false 与具体原因（HTTP 状态、超时、结构不匹配等）。",
    parameters: {
      ...sourcesPathParameter,
      id: { type: "string", required: true, description: "源 id，见 info_sources 的输出" },
      limit: { type: "integer", description: "本次最多返回多少条；0 或缺省沿用清单里的 limit" },
      params: { type: "json", description: "追加/覆盖的查询参数对象，例如 {\"tab\":\"realtime\"}" },
      ...saveParameters,
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          sourceId: { type: "string", required: true },
          label: { type: "string" },
          method: { type: "string" },
          url: { type: "string" },
          status: { type: "number" },
          count: { type: "integer", required: true },
          rawCount: { type: "integer" },
          matchedPath: { type: "string" },
          error: { type: "string" },
          ...saveProperties,
          items: { type: "array", required: true, items: itemSpec() },
        },
      },
      render: (args, value) => {
        const head = value.ok
          ? `${value.label ?? value.sourceId}（${value.method}）取到 ${value.count} 条`
            + (value.rawCount !== undefined && value.rawCount !== value.count ? `（归一化前 ${value.rawCount} 条）` : "")
          : `${value.sourceId} 取数失败：${value.error ?? "未知原因"}`;
        const lines = [head, fileLine(value)];
        if (value.url !== undefined) lines.push(`请求：${value.url}`);
        if (value.matchedPath !== undefined && value.matchedPath !== "") lines.push(`命中字段路径：${value.matchedPath}`);
        for (const [index, item] of value.items.entries()) {
          lines.push(`${String(index + 1).padStart(2, "0")}. ${item.title}${hotText(item)}${itemExtras(item)}`);
          lines.push(summaryLine(item), linkLine(item));
        }
        return text(lines);
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: "generic", title: "采集单个信息源", kind: "info", rawInput: args.id }),
    async execute(args, exec) {
      const registry = loadRegistry({ userPath: requestedSourcesPath(args, exec) });
      const sourceId = String(args.id ?? "").trim();
      const source = registry.sources.find((entry) => entry.id === sourceId);
      if (source === undefined) {
        return {
          ok: false,
          sourceId,
          count: 0,
          items: [],
          error: `清单里没有 id "${sourceId}"；可用：${registry.sources.map((entry) => entry.id).join(", ")}`,
        };
      }
      if (source.ok === false) {
        return {
          ok: false,
          sourceId,
          label: source.label,
          method: source.method,
          count: 0,
          items: [],
          error: `源配置校验未通过：${source.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join("；")}`,
        };
      }
      let params;
      try {
        params = asPlainObject(args.params, "params");
      } catch (error) {
        return { ok: false, sourceId, label: source.label, method: source.method, count: 0, items: [], error: String(error?.message ?? error) };
      }
      const method = getMethod(source.method);
      if (method === undefined) {
        return { ok: false, sourceId, label: source.label, method: source.method, count: 0, items: [], error: `method "${source.method}" 没有对应适配器` };
      }

      let result;
      try {
        result = await method.run(source, { signal: exec?.signal, params, defaults: registry.defaults });
      } catch (error) {
        result = { ok: false, status: 0, error: `适配器异常：${String(error?.message ?? error)}`, items: [] };
      }
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.trunc(Number(args.limit)) : 0;
      const items = limit > 0 ? result.items.slice(0, limit) : result.items;
      const saved = saveCollection(args, {
        heading: `${source.label}（${sourceId}）采集结果`,
        metaLines: [
          `来源 id：\`${sourceId}\`　采集方式：\`${source.method}\``,
          ...(result.url === undefined ? [] : [`请求：${result.url}`]),
          ...(result.matchedPath === undefined || result.matchedPath === "" ? [] : [`命中字段路径：\`${result.matchedPath}\``]),
          ...(result.ok === true ? [] : [`抓取失败：${result.error ?? "未知原因"}`]),
        ],
        sources: [{
          sourceId,
          label: source.label,
          ok: result.ok === true,
          count: items.length,
          ...(result.url === undefined ? {} : { url: result.url }),
          ...(result.matchedPath === undefined ? {} : { matchedPath: result.matchedPath }),
          ...(result.error === undefined ? {} : { error: result.error }),
        }],
        items,
        baseDir: sessionDir(exec),
      });
      return {
        ok: result.ok === true,
        sourceId,
        label: source.label,
        method: source.method,
        ...(result.url === undefined ? {} : { url: result.url }),
        ...(result.status === undefined ? {} : { status: result.status }),
        count: items.length,
        ...(result.rawCount === undefined ? {} : { rawCount: result.rawCount }),
        ...(result.matchedPath === undefined || result.matchedPath === "" ? {} : { matchedPath: result.matchedPath }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...saved,
        items,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "info_collect",
    description:
      "并行从多个源取数并汇总：按 ids（逗号分隔）或 tag 选源，缺省取全部启用的源。"
      + "可选按标题去重（dedupe=title，同标题合并并记下 alsoFrom）与按热度排序（sort=hot）。"
      + "每个源的成败单独返回，部分源失败不影响整体结果。"
      + "汇总结果默认会落盘成一份 markdown（info_collection_<时间戳>.md，默认放工作区根目录），"
      + "用 path 指定目录或文件，用 save=false 关闭。",
    parameters: {
      ...sourcesPathParameter,
      ids: { type: "string", description: "逗号分隔的源 id，例如 aihot-selected,aihot-hot；缺省用 tag 或全部启用源" },
      tag: { type: "string", description: "按标签选源，例如 ai / hot / news" },
      limit: { type: "integer", description: "汇总后最多返回多少条，0 或缺省不限制" },
      dedupe: { type: "string", enum: ["none", "title"], description: "去重方式，默认 none" },
      sort: { type: "string", enum: ["none", "hot"], description: "排序方式，默认保持各源原顺序" },
      params: { type: "json", description: "透传给各源的追加查询参数对象" },
      ...saveParameters,
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          requested: { type: "integer", required: true },
          total: { type: "integer", required: true },
          note: { type: "string" },
          ...saveProperties,
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                sourceId: { type: "string", required: true },
                label: { type: "string" },
                ok: { type: "boolean", required: true },
                count: { type: "integer", required: true },
                rawCount: { type: "integer" },
                matchedPath: { type: "string" },
                error: { type: "string" },
                url: { type: "string" },
                status: { type: "number" },
              },
            },
          },
          items: { type: "array", required: true, items: itemSpec() },
        },
      },
      render: (_args, value) => {
        const labelOf = new Map(value.results.map((entry) => [entry.sourceId, entry.label ?? entry.sourceId]));
        const lines = [
          `汇总 ${value.total} 条（请求 ${value.requested} 个源，成功 ${value.results.filter((entry) => entry.ok).length} 个）`,
          fileLine(value),
        ];
        if (value.note !== undefined) lines.push(value.note);
        for (const entry of value.results) {
          lines.push(`  ${entry.ok ? "✓" : "✗"} ${labelOf.get(entry.sourceId) ?? entry.sourceId}：${entry.ok ? `${entry.count} 条` : entry.error}`);
        }
        lines.push("");
        for (const [index, item] of value.items.entries()) {
          const from = labelOf.get(item.sourceId) ?? item.sourceId;
          lines.push(`${String(index + 1).padStart(2, "0")}. [${from}] ${item.title}${hotText(item)}${itemExtras(item, labelOf)}`);
          lines.push(summaryLine(item), linkLine(item));
        }
        return text(lines);
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: "generic", title: "多源采集信息", kind: "info", rawInput: args.ids ?? args.tag ?? "all" }),
    async execute(args, exec) {
      const registry = loadRegistry({ userPath: requestedSourcesPath(args, exec) });
      let params;
      try {
        params = asPlainObject(args.params, "params");
      } catch (error) {
        return { ok: false, requested: 0, total: 0, results: [], items: [], note: String(error?.message ?? error) };
      }
      const { selected, unknownIds } = selectSources(registry, {
        ids: toIdList(args.ids),
        tag: typeof args.tag === "string" ? args.tag.trim() : undefined,
        includeDisabled: false,
      });

      if (selected.length === 0) {
        return {
          ok: false,
          requested: 0,
          total: 0,
          results: [],
          items: [],
          note: `没有匹配的源（ids=${args.ids ?? "-"}，tag=${args.tag ?? "-"}）；用 info_sources 查看可用 id 与标签`,
        };
      }

      const { results, items } = await collect(selected, { signal: exec?.signal, params, defaults: registry.defaults });
      for (const id of unknownIds) results.push({ sourceId: id, ok: false, count: 0, error: "清单里没有这个 id" });

      const dedupe = args.dedupe === "title" ? "title" : "none";
      const sort = args.sort === "hot" ? "hot" : "none";
      let merged = dedupe === "title" ? dedupeByTitle(items) : items;
      if (sort === "hot") merged = sortByHot(merged);
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.trunc(Number(args.limit)) : 0;
      const finalItems = limit > 0 ? merged.slice(0, limit) : merged;
      const labelOf = new Map(results.map((entry) => [entry.sourceId, entry.label ?? entry.sourceId]));
      const saved = saveCollection(args, {
        heading: "多源采集汇总",
        metaLines: [
          `请求源：${results.map((entry) => `\`${entry.sourceId}\``).join("、")}`,
          `去重：${dedupe === "title" ? "按标题合并" : "不去重"}　排序：${sort === "hot" ? "按热度降序" : "各源原顺序"}`,
          ...(dedupe === "none" && items.length === finalItems.length ? [] : [`原始 ${items.length} 条 → 去重/截断后 ${finalItems.length} 条`]),
        ],
        sources: results,
        items: finalItems,
        labelOf,
        baseDir: sessionDir(exec),
      });

      return {
        ok: results.every((entry) => entry.ok),
        requested: selected.length + unknownIds.length,
        total: finalItems.length,
        ...(dedupe === "none" && items.length === finalItems.length ? {} : { note: `原始 ${items.length} 条 → 去重/截断后 ${finalItems.length} 条` }),
        ...saved,
        results: results.map((entry) => ({
          sourceId: entry.sourceId,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          ok: entry.ok,
          count: entry.count,
          ...(entry.rawCount === undefined ? {} : { rawCount: entry.rawCount }),
          ...(entry.matchedPath === undefined ? {} : { matchedPath: entry.matchedPath }),
          ...(entry.error === undefined ? {} : { error: entry.error }),
          ...(entry.url === undefined ? {} : { url: entry.url }),
          ...(entry.status === undefined ? {} : { status: entry.status }),
        })),
        items: finalItems,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "info_reload",
    description:
      "强制重新读取源清单（默认层 config/sources.json，以及本次显式指定的覆盖层），返回条目数与全部校验问题。"
      + "清单在文件 mtime 变化时本来就会自动重载，这个工具用于改完文件/环境变量后立刻确认结果。",
    parameters: { ...sourcesPathParameter },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reloaded: { type: "boolean", required: true },
          total: { type: "integer", required: true },
          enabledCount: { type: "integer", required: true },
          builtin: { type: "string", required: true },
          user: { type: "string" },
          userExists: { type: "boolean", required: true },
          loadedAt: { type: "string", required: true },
          issues: { type: "array", required: true, items: issueSpec() },
        },
      },
      render: (_args, value) => text([
        `已重载清单：${value.total} 个源（启用 ${value.enabledCount} 个），于 ${value.loadedAt}`,
        `内置 ${value.builtin}`,
        value.userExists ? `覆盖层 ${value.user}` : "覆盖层：本次未使用",
        value.issues.length === 0 ? "校验：全部通过" : `校验问题 ${value.issues.length} 条：`,
        ...value.issues.map((issue) => `  [${issue.level}] ${issue.id}：${issue.message}`),
      ]),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "重载信息源清单", kind: "info", rawInput: "reload" }),
    async execute(args, exec) {
      const registry = loadRegistry({ force: true, userPath: requestedSourcesPath(args, exec) });
      return {
        reloaded: true,
        total: registry.sources.length,
        enabledCount: registry.sources.filter((source) => source.enabled).length,
        builtin: registry.paths.builtin,
        ...(registry.paths.user === undefined ? {} : { user: registry.paths.user }),
        userExists: registry.paths.userExists,
        loadedAt: registry.loadedAt,
        issues: registry.issues.map((issue) => ({ id: issue.id, level: issue.level, message: issue.message })),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "info_source_save",
    description:
      "以程序方式维护覆盖层清单：把某个源的字段写进用户配置文件（新增或更新），或删除该覆盖条目。"
      + "patch 可只写要改的字段，例如 {\"enabled\": false} 停用一个内置源、{\"url\": \"...\"} 换地址、"
      + "或写全 id/url/select 新增一个自定义源。写入后自动重载。",
    parameters: {
      sourcesPath: {
        type: "string",
        required: true,
        description: "要写入的用户覆盖层 JSON 路径；必须显式提供。相对路径按会话工作区解析。",
      },
      id: { type: "string", required: true, description: "源 id" },
      patch: { type: "json", description: "要写入覆盖层的字段对象" },
      remove: { type: "boolean", description: "为 true 时删除覆盖层里的该条目（回到默认层定义）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          action: { type: "string", required: true },
          id: { type: "string", required: true },
          enabled: { type: "boolean" },
          total: { type: "integer", required: true },
          overrides: { type: "array", items: { type: "string" } },
          issues: { type: "array", required: true, items: issueSpec() },
        },
      },
      render: (_args, value) => text([
        `${value.action === "remove" ? "已删除覆盖条目" : "已写入覆盖层"}：${value.id} → ${value.path}`,
        value.overrides !== undefined && value.overrides.length > 0 ? `覆盖字段：${value.overrides.join(", ")}` : undefined,
        `当前清单 ${value.total} 个源`,
        value.issues.length === 0 ? "校验：全部通过" : `校验问题 ${value.issues.length} 条：`,
        ...value.issues.map((issue) => `  [${issue.level}] ${issue.id}：${issue.message}`),
      ]),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: "generic", title: "维护信息源清单", kind: "info", rawInput: args.id }),
    async execute(args, exec) {
      const id = String(args.id ?? "").trim();
      const patch = asPlainObject(args.patch, "patch");
      const userPath = requestedSourcesPath(args, exec);
      if (userPath === undefined) throw new Error("sourcesPath 必须显式提供");
      const saved = saveUserSource(id, patch, { remove: args.remove === true, userPath });
      const registry = loadRegistry({ force: true, userPath });
      const source = registry.sources.find((entry) => entry.id === id);
      return {
        path: saved.path,
        action: saved.action,
        id,
        ...(source === undefined ? {} : { enabled: source.enabled }),
        total: registry.sources.length,
        ...(Array.isArray(source?.overrides) && source.overrides.length > 0 ? { overrides: source.overrides } : {}),
        issues: registry.issues.map((issue) => ({ id: issue.id, level: issue.level, message: issue.message })),
      };
    },
  }));
}
