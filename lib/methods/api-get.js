/**
 * 采集方式适配器：api-get —— HTTP GET 一个 JSON 接口，按清单里的 select 映射成统一条目。
 *
 * 适配器契约（新增方式时照抄这个形状即可，见 lib/methods/index.js）：
 *   { id, label, summary, requiredKeys, async run(source, { signal, params, defaults }) }
 * run 返回：
 *   { ok: true,  status, url, items: Item[], rawCount }
 *   { ok: false, status, url, error, items: [] }
 * Item 统一形状（可选字段没有值时不写该键）：
 *   { sourceId, title, rank, hot?, url?, originalUrl?, origin?, publishedAt?, summary?, label? }
 */
import { buildUrl, request, snippet } from "../http.js";
import { getField, pickInteger, pickNumber, pickString, selectNodes } from "../select.js";
import { effectiveLimit, effectiveTimeout, mergeHeaders } from "../source-util.js";

/** 一条原始节点 → 统一条目；title 为空视为无效条目（返回 null，由调用方过滤） */
function toItem(node, source, index) {
  const select = source.select ?? {};
  const title = pickString(getField(node, select.title));
  if (title === undefined) return null;

  const rank = pickInteger(getField(node, select.rank)) ?? index + 1;
  const hot = pickNumber(getField(node, select.hot));
  const url = pickString(getField(node, select.url));
  const label = pickString(getField(node, select.label));
  const originalUrl = pickString(getField(node, select.originalUrl));
  const origin = pickString(getField(node, select.origin));
  const summary = pickString(getField(node, select.summary));
  const publishedAt = pickString(getField(node, select.publishedAt));

  return {
    sourceId: source.id,
    title,
    rank,
    ...(hot === undefined ? {} : { hot }),
    ...(url === undefined ? {} : { url }),
    ...(originalUrl === undefined ? {} : { originalUrl }),
    ...(origin === undefined ? {} : { origin }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(summary === undefined ? {} : { summary }),
    ...(label === undefined ? {} : { label }),
  };
}

/** 依次尝试 items 与 itemsFallback，第一个取到节点的路径生效 —— 接口结构变了只改清单 */
function selectItemNodes(data, select) {
  const paths = [select?.items, ...(Array.isArray(select?.itemsFallback) ? select.itemsFallback : [])];
  let fallbackCandidates = 0;
  let used = null;
  for (const path of paths) {
    if (path === undefined || path === null) continue;
    const nodes = selectNodes(data, path);
    fallbackCandidates += nodes.length;
    if (nodes.length > 0) {
      used = { path, nodes };
      break;
    }
  }
  if (used === null) return { nodes: [], path: paths[0] ?? "", fallbackCandidates };
  return { nodes: used.nodes, path: used.path, fallbackCandidates };
}

export const apiGet = {
  id: "api-get",
  label: "HTTP GET（JSON 接口）",
  summary: "GET 一个返回 JSON 的接口，按 select 把任意结构映射成统一条目；支持 query 参数、请求头、超时与 itemsFallback。",
  /** 清单校验时必填的键（点号表示嵌套），由 registry 读取 */
  requiredKeys: ["url", "select.title"],

  async run(source, { signal, params, defaults } = {}) {
    let url;
    try {
      url = buildUrl(source, params);
    } catch (error) {
      return { ok: false, status: 0, url: String(source.url ?? ""), error: `URL 不合法：${String(error?.message ?? error)}`, items: [] };
    }

    const headers = mergeHeaders(source, defaults, { Accept: "application/json, text/plain, */*" });
    const response = await request(url, {
      headers,
      timeoutMs: effectiveTimeout(source, defaults),
      signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, url, error: response.error, items: [] };
    }

    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      return { ok: false, status: response.status, url, error: `返回体不是 JSON：${snippet(response.body)}`, items: [] };
    }

    const picked = selectItemNodes(data, source.select);
    const items = [];
    for (const [index, node] of picked.nodes.entries()) {
      const item = toItem(node, source, index);
      if (item !== null) items.push(item);
    }

    const limit = effectiveLimit(source, defaults);
    return {
      ok: true,
      status: response.status,
      url,
      items: limit > 0 ? items.slice(0, limit) : items,
      rawCount: items.length,
      matchedPath: picked.path,
    };
  },
};
