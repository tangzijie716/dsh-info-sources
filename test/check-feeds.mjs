/**
 * feed 体检 —— 判断一批 RSS/Atom 地址能不能当源用。
 *
 *   node test/check-feeds.mjs <url> [url...]
 *
 * 刻意复用插件自己的代码路径（lib/http.js 的请求层 + lib/feed.js 的解析器），
 * 所以「体检通过」就等于「加成 rss 源后能取到东西」，不是另写一套判断逻辑。
 *
 * 每条给出：HTTP 状态、最终 URL、内容类型、字节数、识别出的格式（rss/atom/rdf）、
 * feed 标题、条目数，以及字段完整度（标题/链接/时间/摘要各有多少条有值）。
 */
import { parseFeed } from "../lib/feed.js";
import { request } from "../lib/http.js";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("用法：node test/check-feeds.mjs <url> [url...]");
  process.exit(2);
}

const pct = (count, total) => (total === 0 ? "—" : `${count}/${total}`);
const clip = (text, max = 100) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const results = [];

for (const url of urls) {
  console.log(`\n${"=".repeat(70)}\n${url}`);
  const response = await request(url, {
    headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    timeoutMs: 20000,
  });
  if (!response.ok) {
    console.log(`  ✗ 请求失败：${response.error}`);
    results.push({ url, ok: false, why: response.error });
    continue;
  }
  console.log(`  HTTP ${response.status}  charset=${response.charset}  bytes=${Buffer.byteLength(response.body, "utf8")}`);

  const feed = parseFeed(response.body);
  if (feed === null) {
    console.log(`  ✗ 不是 feed（没找到 <rss>/<feed>/<rdf:RDF>）`);
    console.log(`    返回体开头：${clip(response.body, 160)}`);
    results.push({ url, ok: false, why: "不是 feed" });
    continue;
  }

  const items = feed.items;
  const withTitle = items.filter((item) => item.title !== undefined).length;
  const withLink = items.filter((item) => item.link !== undefined).length;
  const withDate = items.filter((item) => item.publishedAt !== undefined).length;
  const withSummary = items.filter((item) => item.description !== undefined).length;
  console.log(`  ✓ 格式=${feed.format}  feed 标题=${feed.title ?? "（无）"}`);
  console.log(`  条目=${items.length}  标题 ${pct(withTitle, items.length)} · 链接 ${pct(withLink, items.length)} · 时间 ${pct(withDate, items.length)} · 摘要 ${pct(withSummary, items.length)}`);
  for (const [index, item] of items.slice(0, 2).entries()) {
    console.log(`  [${index + 1}] ${clip(item.title, 70)}`);
    console.log(`      link=${clip(item.link, 90)}`);
    console.log(`      author=${clip(item.author, 40)}  publishedAt=${item.publishedAt ?? "（无）"}`);
    console.log(`      desc=${clip(item.description, 110)}`);
  }
  results.push({
    url,
    ok: items.length > 0 && withTitle === items.length,
    format: feed.format,
    title: feed.title,
    items: items.length,
    fields: { link: withLink, date: withDate, summary: withSummary },
  });
}

console.log(`\n${"=".repeat(70)}\n汇总`);
for (const entry of results) {
  if (!entry.ok || entry.items === undefined) {
    console.log(`  ✗ ${entry.url}\n      ${entry.why ?? "无有效条目"}`);
    continue;
  }
  const missing = [];
  if (entry.fields.date < entry.items) missing.push("部分无时间");
  if (entry.fields.summary === 0) missing.push("无摘要");
  console.log(`  ✓ ${entry.url}\n      ${entry.format} · ${entry.items} 条 · ${entry.title ?? "无标题"}${missing.length > 0 ? ` · ⚠️ ${missing.join("、")}` : ""}`);
}
