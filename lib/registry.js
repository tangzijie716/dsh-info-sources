/**
 * 源清单（source registry）—— 「API 地址不要硬编码」的落点。
 *
 * 清单分两层，运行时合并：
 *   1. 默认层：包内 config/sources.json（随包发布，升级包会覆盖，所以别在这里存私货）
 *   2. 覆盖层：调用方通过 sourcesPath 显式传入；不传时只使用默认层
 *      覆盖层按 id 覆盖默认层，只写 { "id": "baidu-hot", "enabled": false } 就能停用一个内置源；
 *      写全一点就能新增一个自定义源。
 *
 * 其它约定：
 *   - 以 `_` 或 `$` 开头的键一律当注释/示例忽略，可以在 JSON 里写维护备注。
 *   - 字符串值支持 $ENV:NAME（必填）与 $ENV:NAME?（缺失则丢弃所在的查询参数/请求头），
 *     Cookie / Token 因此不进代码也不进仓库。
 *   - 清单文件按 mtime 自动热重载：改完文件下次调用就生效，不用重启 harness。
 *   - 校验问题不抛异常，收进 issues（level: error / warn），由 info_sources 完整展示。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMethod, listMethods } from "./methods/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const BUILTIN_PATH = join(PACKAGE_ROOT, "config", "sources.json");

/** 源条目允许出现的键；出现别的键会被提示（多半是拼错了） */
const ALLOWED_SOURCE_KEYS = new Set([
  "id", "label", "method", "enabled", "tags", "url", "query", "headers",
  "select", "limit", "timeoutMs", "note", "body",
]);
/** defaults 允许出现的键 */
const ALLOWED_DEFAULTS_KEYS = new Set(["method", "timeoutMs", "limit", "headers"]);

const isCommentKey = (key) => key.startsWith("_") || key.startsWith("$");
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** 用户覆盖层路径 */
function explicitUserPath(path) {
  const value = typeof path === "string" ? path.trim() : "";
  return value === "" ? undefined : resolve(value);
}

// ── $ENV 插值 ──────────────────────────────────────────────────────────────
const ENV_TOKEN = /\$ENV:([A-Za-z_][A-Za-z0-9_]*)(\?)?/g;

/**
 * 解析字符串里的 $ENV 记号。
 * @returns {{ text: string, dropped: boolean, missing: Array<{name: string, optional: boolean}> }}
 */
function interpolate(text, missing) {
  let dropped = false;
  const out = String(text).replace(ENV_TOKEN, (_match, name, optional) => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      missing.push({ name, optional: optional === "?" });
      if (optional === "?") dropped = true;
      return "";
    }
    return value;
  });
  return { text: out, dropped, missing };
}

/** 对一个键值表（query / headers）做插值：可选变量缺失且结果为空时，丢掉整个键 */
function interpolateMap(map, missing) {
  const out = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    if (isCommentKey(key)) continue;
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const resolved = interpolate(value, missing);
    if (resolved.dropped && resolved.text === "") continue;
    out[key] = resolved.text;
  }
  return out;
}

/** 只对可能带密钥的字段做插值，并记下缺失的环境变量 */
function applyEnv(entry) {
  const missing = [];
  const next = { ...entry };
  if (typeof next.url === "string") next.url = interpolate(next.url, missing).text;
  if (isPlainObject(next.query)) next.query = interpolateMap(next.query, missing);
  if (isPlainObject(next.headers)) next.headers = interpolateMap(next.headers, missing);
  if (missing.length > 0) next.envMissing = missing;
  return next;
}

// ── 读取与合并 ────────────────────────────────────────────────────────────
/** 注释掉的源放在 `_disabled`（`_` 开头的键一律不解析，所以它们既不校验也不采集，但原样留在文件里） */
function commentedEntries(doc) {
  return Array.isArray(doc?._disabled) ? doc._disabled.filter(isPlainObject) : [];
}

function readDoc(path, { required }) {
  if (!existsSync(path)) {
    if (required) throw new Error(`清单文件不存在：${path}`);
    return null;
  }
  const text = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`清单文件不是合法 JSON：${path}（${String(error?.message ?? error)}）`);
  }
  if (Array.isArray(parsed)) return { version: 1, defaults: {}, sources: parsed, commented: [] };
  if (!isPlainObject(parsed)) throw new Error(`清单文件顶层必须是对象或数组：${path}`);
  return {
    version: parsed.version ?? 1,
    defaults: isPlainObject(parsed.defaults) ? parsed.defaults : {},
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    commented: commentedEntries(parsed),
  };
}

function mergeDefaults(builtin, user) {
  const merged = { ...builtin, ...(user ?? {}) };
  merged.headers = { ...(builtin.headers ?? {}), ...(user?.headers ?? {}) };
  return merged;
}

/** 默认层 + 覆盖层 按 id 合并；覆盖层里出现的新 id 追加在后面 */
function mergeSources(builtinSources, userSources) {
  const order = [];
  const byId = new Map();
  for (const entry of builtinSources) {
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "" || byId.has(id)) continue;
    order.push(id);
    byId.set(id, { ...entry, id, origin: "builtin" });
  }
  for (const entry of userSources) {
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "") continue;
    const base = byId.get(id);
    if (base === undefined) {
      order.push(id);
      byId.set(id, { ...entry, id, origin: "user", overrides: Object.keys(entry).filter((key) => !isCommentKey(key) && key !== "id") });
      continue;
    }
    byId.set(id, {
      ...base,
      ...entry,
      id,
      origin: "user",
      overrides: Object.keys(entry).filter((key) => !isCommentKey(key) && key !== "id"),
    });
  }
  return order.map((id) => byId.get(id));
}

function reportDuplicateIds(entries, layer, issues) {
  const seen = new Set();
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "" || isCommentKey(id)) continue;
    if (seen.has(id)) issues.push({ id, level: "error", message: `${layer}内 id 重复；请删除重复条目` });
    seen.add(id);
  }
}

function validateDefaults(defaults, layer, issues) {
  for (const key of Object.keys(defaults ?? {})) {
    if (!ALLOWED_DEFAULTS_KEYS.has(key)) issues.push({ id: "(defaults)", level: "warn", message: `${layer}含未知字段 "${key}"` });
  }
  if (defaults?.limit !== undefined && (!Number.isFinite(Number(defaults.limit)) || Number(defaults.limit) < 0)) {
    issues.push({ id: "(defaults)", level: "error", message: `${layer}.limit 必须是 ≥0 的数字` });
  }
  if (defaults?.timeoutMs !== undefined && (!Number.isFinite(Number(defaults.timeoutMs)) || Number(defaults.timeoutMs) <= 0)) {
    issues.push({ id: "(defaults)", level: "error", message: `${layer}.timeoutMs 必须是正数` });
  }
  if (defaults?.headers !== undefined && !isPlainObject(defaults.headers)) {
    issues.push({ id: "(defaults)", level: "error", message: `${layer}.headers 必须是对象` });
  }
}

// ── 校验 ──────────────────────────────────────────────────────────────────
function readPath(object, dotted) {
  let current = object;
  for (const key of String(dotted).split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function validateSources(sources, defaults, issues) {
  const seen = new Set();
  return sources.map((entry) => {
    const id = entry.id ?? "(缺少 id)";
    const push = (level, message) => issues.push({ id, level, message });
    const localIssues = [];
    const pushLocal = (level, message) => {
      push(level, message);
      localIssues.push({ level, message });
    };

    if (seen.has(id)) pushLocal("error", "id 重复，后面的条目不会生效");
    seen.add(id);

    for (const key of Object.keys(entry)) {
      if (isCommentKey(key) || key === "origin" || key === "overrides" || key === "envMissing") continue;
      if (!ALLOWED_SOURCE_KEYS.has(key)) pushLocal("warn", `未知字段 "${key}"（会被忽略，检查是否拼错）`);
    }

    const methodId = entry.method ?? defaults.method;
    const method = getMethod(methodId);
    if (method === undefined) {
      pushLocal("error", `method "${methodId}" 没有对应适配器；已注册：${listMethods().map((m) => m.id).join(", ")}`);
    }

    if (entry.limit !== undefined && (!Number.isFinite(Number(entry.limit)) || Number(entry.limit) < 0)) {
      pushLocal("error", `limit 必须是 ≥0 的数字，当前为 ${JSON.stringify(entry.limit)}`);
    }
    if (entry.timeoutMs !== undefined && (!Number.isFinite(Number(entry.timeoutMs)) || Number(entry.timeoutMs) <= 0)) {
      pushLocal("error", `timeoutMs 必须是正数，当前为 ${JSON.stringify(entry.timeoutMs)}`);
    }
    if (entry.query !== undefined && !isPlainObject(entry.query)) pushLocal("error", "query 必须是对象");
    if (entry.headers !== undefined && !isPlainObject(entry.headers)) pushLocal("error", "headers 必须是对象");
    if (entry.tags !== undefined && !Array.isArray(entry.tags)) pushLocal("error", "tags 必须是数组");
    if (Array.isArray(entry.tags) && entry.tags.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
      pushLocal("error", "tags 的每一项都必须是非空字符串");
    }
    if (entry.select?.itemsFallback !== undefined
      && (!Array.isArray(entry.select.itemsFallback) || entry.select.itemsFallback.some((path) => typeof path !== "string" || path.trim() === ""))) {
      pushLocal("error", "select.itemsFallback 必须是非空字符串数组");
    }

    if (method !== undefined) {
      for (const key of method.requiredKeys) {
        const value = readPath(entry, key);
        if (value === undefined || value === null || String(value).trim() === "") {
          pushLocal("error", `method "${methodId}" 需要 ${key}`);
        }
      }
      if (typeof entry.url === "string" && !/^https?:\/\//i.test(entry.url)) {
        pushLocal("error", `url 必须以 http:// 或 https:// 开头，当前为 ${entry.url}`);
      }
    }

    for (const miss of entry.envMissing ?? []) {
      if (!miss.optional) pushLocal("error", `缺少必填环境变量 ${miss.name}（清单里写了 $ENV:${miss.name}）`);
      else pushLocal("warn", `环境变量 ${miss.name} 未设置，相关请求头/参数已丢弃（可选，属正常）`);
    }

    const enabled = entry.enabled !== false;
    if (!enabled && localIssues.some((issue) => issue.level === "error")) {
      for (const issue of localIssues) if (issue.level === "error") issue.message += "（该源当前 enabled=false，报错不影响采集）";
    }

    return {
      ...entry,
      method: methodId,
      enabled,
      label: typeof entry.label === "string" && entry.label.trim() !== "" ? entry.label.trim() : id,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string") : [],
      ok: !localIssues.some((issue) => issue.level === "error"),
      issues: localIssues,
    };
  });
}

/** 文件指纹：内容变化（mtime/大小）即触发重载 */
function stampOf(path) {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "absent";
  }
}

const cache = new Map();

/**
 * 载入清单（默认带缓存；文件变了或 force=true 才真正重读）。
 * @returns {{ version, defaults, sources, issues, methods, paths: {builtin, user, userExists}, loadedAt }}
 */
export function loadRegistry({ force = false, userPath: requestedUserPath } = {}) {
  const builtinPath = BUILTIN_PATH;
  const userPath = explicitUserPath(requestedUserPath);
  const cacheKey = userPath ?? "(builtin-only)";
  const stamp = `${builtinPath}|${stampOf(builtinPath)}|${userPath ?? ""}|${userPath === undefined ? "unused" : stampOf(userPath)}`;
  const cached = cache.get(cacheKey);
  if (!force && cached?.stamp === stamp) return cached.registry;

  const issues = [];
  const builtin = readDoc(builtinPath, { required: true });
  const user = userPath === undefined ? null : readDoc(userPath, { required: true });
  const userExists = userPath !== undefined;

  if (builtin.version !== 1) throw new Error(`不支持的内置清单版本：${builtin.version}`);
  if (user !== null && user.version !== 1) throw new Error(`不支持的覆盖层清单版本：${user.version}`);
  reportDuplicateIds(builtin.sources ?? [], "内置清单", issues);
  reportDuplicateIds(user?.sources ?? [], "覆盖层", issues);
  validateDefaults(builtin.defaults ?? {}, "内置 defaults", issues);
  validateDefaults(user?.defaults ?? {}, "覆盖层 defaults", issues);
  const defaults = mergeDefaults(builtin.defaults ?? {}, user?.defaults);
  if (typeof defaults.method !== "string") defaults.method = "api-get";
  if (!Number.isFinite(Number(defaults.timeoutMs))) defaults.timeoutMs = 15000;
  if (!Number.isFinite(Number(defaults.limit))) defaults.limit = 30;
  defaults.headers = interpolateMap(defaults.headers ?? {}, []);

  const merged = mergeSources(builtin.sources ?? [], user?.sources ?? []);
  const resolved = merged.map((entry) => applyEnv({ ...entry, headers: isPlainObject(entry.headers) ? entry.headers : undefined }));
  const sources = validateSources(resolved, defaults, issues);

  const commentedOut = [...new Set(
    [...(builtin.commented ?? []), ...(user?.commented ?? [])]
      .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
      .filter((id) => id !== ""),
  )];

  const registry = {
    version: builtin.version ?? 1,
    defaults,
    sources,
    commentedOut,
    issues,
    methods: listMethods(),
    paths: { builtin: builtinPath, ...(userPath === undefined ? {} : { user: userPath }), userExists },
    loadedAt: new Date().toISOString(),
  };
  cache.set(cacheKey, { stamp, registry });
  return registry;
}

/** 清缓存，强制下次重读（saveUserSource 会自动调用） */
function invalidateRegistry() {
  cache.clear();
}

/**
 * 以程序方式维护覆盖层：新增/更新/删除一个用户源条目。
 * @param id 源 id
 * @param patch 要写入的字段（可只写部分字段，例如 { enabled: false }）
 * @param options.remove 为 true 时删除覆盖层里的该 id（回到默认层）
 * @param options.userPath 必须显式提供的覆盖层文件路径
 * @returns {{ path, action, id, entry }}
 */
export function saveUserSource(id, patch = {}, { remove = false, userPath: requestedUserPath } = {}) {
  const sourceId = typeof id === "string" ? id.trim() : "";
  if (sourceId === "") throw new Error("saveUserSource：id 不能为空");
  const path = explicitUserPath(requestedUserPath);
  if (path === undefined) throw new Error("saveUserSource：必须显式传入覆盖层文件路径");

  let doc;
  if (existsSync(path)) {
    doc = readDoc(path, { required: false });
    if (doc === null) doc = { version: 1, defaults: {}, sources: [] };
  } else {
    doc = { version: 1, defaults: {}, sources: [] };
  }
  const sources = doc.sources.filter((entry) => isPlainObject(entry) && !isCommentKey(String(entry.id ?? "")));
  const index = sources.findIndex((entry) => String(entry.id).trim() === sourceId);

  let action;
  if (remove) {
    if (index >= 0) sources.splice(index, 1);
    action = "remove";
  } else {
    const clean = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (isCommentKey(key) || key === "id") continue;
      clean[key] = value;
    }
    if (index >= 0) {
      sources[index] = { ...sources[index], ...clean, id: sourceId };
      action = "upsert";
    } else {
      sources.push({ ...clean, id: sourceId });
      action = "upsert";
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  const next = { ...doc, version: doc.version ?? 1, sources };
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  invalidateRegistry();

  return { path, action, id: sourceId, entry: sources.find((entry) => String(entry.id).trim() === sourceId) ?? null };
}
