/**
 * 采集方式适配器：rss —— GET 一个 RSS 2.0 / Atom / RSS 1.0(RDF) 订阅源。
 *
 * 与 api-get 的区别：feed 不是 JSON，所以没有 `select` 字段映射，采用固定映射：
 *   title       ← <title>
 *   url         ← <link>（Atom 取 rel=alternate 的 href）
 *   summary     ← <description> / <summary> / <content:encoded> / <content>，解实体 + 剥 HTML 并压成一行
 *   origin      ← <author>（Atom 的 <author><name>、dc:creator 都认）→ <category domain="source"> 的文本
 *                 → feed 标题（雷达/聚合类 feed 常用 domain="source" 标注真实来源）
 *   publishedAt ← <pubDate> / <published> / <updated> / <dc:date>，统一转成 ISO 8601
 *   label       ← 第一个不带 domain 属性的 <category>（Atom 取 term 属性）
 *   hot         ← feed 没有热度，不输出
 *
 * 仍然沿用清单里的通用字段：limit、timeoutMs、headers、query、url 里的 {key} 路径参数。
 */
import { parseFeed, textFromHtml } from "../feed.js";
import { buildUrl, request, snippet } from "../http.js";
import { effectiveLimit, effectiveTimeout, mergeHeaders } from "../source-util.js";

/** 摘要上限：feed 的详细摘要可能很长，给个上限避免单条淹没输出 */
const SUMMARY_MAX = 2000;

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const rss = {
  id: "rss",
  label: "RSS / Atom 订阅",
  summary: "GET 一个 RSS 2.0 / Atom / RSS 1.0(RDF) 订阅源，按固定映射把条目统一成同一形状（标题、链接、摘要、出处、发布时间、分类）。",
  requiredKeys: ["url"],

  async run(source, { signal, params, defaults } = {}) {
    let url;
    try {
      url = buildUrl(source, params);
    } catch (error) {
      return { ok: false, status: 0, url: String(source.url ?? ""), error: `URL 不合法：${String(error?.message ?? error)}`, items: [] };
    }

    const headers = mergeHeaders(source, defaults, {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    });
    const response = await request(url, {
      headers,
      timeoutMs: effectiveTimeout(source, defaults),
      signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, url, error: response.error, items: [] };
    }

    let feed;
    try {
      feed = parseFeed(response.body);
    } catch (error) {
      return { ok: false, status: response.status, url, error: `feed 解析失败：${String(error?.message ?? error)}`, items: [] };
    }
    if (feed === null) {
      return {
        ok: false,
        status: response.status,
        url,
        error: `返回体不是 feed（没找到 <rss>/<feed>/<rdf:RDF>）：${snippet(response.body)}`,
        items: [],
      };
    }

    const items = [];
    for (const [index, entry] of feed.items.entries()) {
      const title = entry.title?.trim();
      if (title === undefined || title === "") continue;
      const summarySource = entry.description;
      const summary = summarySource === undefined ? undefined : clip(textFromHtml(summarySource), SUMMARY_MAX);
      const category = entry.categories.find((candidate) => candidate.domain === undefined) ?? entry.categories[0];
      const sourceCategory = entry.categories.find((candidate) => candidate.domain !== undefined);
      const origin = entry.author ?? sourceCategory?.text ?? feed.title;
      items.push({
        sourceId: source.id,
        title,
        rank: index + 1,
        ...(entry.link === undefined ? {} : { url: entry.link }),
        ...(summary === undefined || summary === "" ? {} : { summary }),
        ...(origin === undefined ? {} : { origin }),
        ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
        ...(category?.text === undefined ? {} : { label: category.text }),
      });
    }

    const limit = effectiveLimit(source, defaults);
    return {
      ok: true,
      status: response.status,
      url,
      items: limit > 0 ? items.slice(0, limit) : items,
      rawCount: items.length,
      matchedPath: `${feed.format}:item`,
    };
  },
};
