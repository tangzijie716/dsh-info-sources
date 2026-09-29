/**
 * 本地验证：用假 ctx 拿到 5 个工具定义后直接调用。
 *
 *   node test/run.mjs
 *
 * 覆盖：
 *   A. 工具注册与 schema 编译
 *   B. 本地 HTTP 接口（确定性）：字段映射（标题/热度/摘要/出处/原文/时间）/ itemsFallback /
 *      query 合并与覆盖 / {key} 路径参数与其缺值报错 / 可选 $ENV 请求头缺失时丢弃 / limit / 404 / 非 JSON / 未知 id
 *   C. 覆盖层维护：saveUserSource 新增·停用·删除，且不破坏文件里的其它条目
 *   D. 清单校验：未知 method、非 http url、必填环境变量缺失都能报出来；
 *      默认层 sources 只留 AIHOT，其余源进 _disabled 注释块且仍在文件里
 *   E. 真接口冒烟（AIHOT，网络不可用只 WARN 不 FAIL）
 *   F. 落盘：默认文件名 info_collection_<时间戳>.md、目录解析优先级、显式路径、撞名退让、save=false
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileStamp, resolveOutput, writeCollection } from "../lib/output.js";
import { decodeEntities, parseFeed, stripHtml, textFromHtml } from "../lib/feed.js";
import { effectiveLimit } from "../lib/source-util.js";

let failures = 0;
let warnings = 0;

const section = (title) => console.log(`\n${"─".repeat(4)} ${title} ${"─".repeat(4)}`);
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail === "" ? "" : `　→ ${detail}`}`);
  }
};
const softCheck = (name, ok, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    warnings++;
    console.log(`  ⚠ ${name}（网络相关，跳过）${detail === "" ? "" : `　→ ${detail}`}`);
  }
};

// ── B 的前置：本地接口 ────────────────────────────────────────────────────
// RSS 样例：CDATA、实体、HTML 描述、content:encoded 回退、domain 型 category、RFC822 时间
const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>测试订阅源 &amp; 示例</title>
    <link>https://example.com/feed</link>
    <description>本地测试 feed</description>
    <atom:link href="https://example.com/feed" rel="self" type="application/rss+xml" />
    <item>
      <title><![CDATA[带 CDATA 的标题 & 特殊字符 <标签>]]></title>
      <link>https://example.com/posts/1</link>
      <guid isPermaLink="true">https://example.com/posts/1</guid>
      <description><![CDATA[<p>第一段&nbsp;描述</p><p>第二段</p>]]></description>
      <author>作者甲</author>
      <pubDate>Sat, 26 Sep 2026 15:34:48 +0800</pubDate>
      <category>AI</category>
      <category domain="source">example.com</category>
    </item>
    <item>
      <title>实体与数字引用 &amp; &#x4E2D;文</title>
      <link>https://example.com/posts/2</link>
      <description>普通描述，<b>带标签</b></description>
      <dc:creator>作者乙</dc:creator>
      <pubDate>Fri, 25 Sep 2026 08:00:00 GMT</pubDate>
      <category>模型</category>
    </item>
    <item>
      <title>只有 content:encoded 的条目</title>
      <link>https://example.com/posts/3</link>
      <content:encoded><![CDATA[<p>正文摘要来自 content:encoded</p>]]></content:encoded>
      <category>论文</category>
    </item>
    <item>
      <title>只有来源域名的条目</title>
      <link>https://example.com/posts/4</link>
      <category domain="source">bestblogs.dev</category>
      <category>资讯</category>
    </item>
  </channel>
</rss>`;

// Atom 样例：属性式 link（含 rel=self 干扰项）、author/name、published、term 型 category、转义 HTML 正文
const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 测试源</title>
  <link href="https://example.com/atom" rel="self" />
  <entry>
    <title>Atom 条目一</title>
    <link rel="self" href="https://example.com/atom/self-1" />
    <link href="https://example.com/atom/1" />
    <id>tag:example.com,2026:1</id>
    <updated>2026-09-26T08:00:00Z</updated>
    <summary>Atom 摘要一</summary>
    <author><name>Atom 作者</name></author>
    <category term="AI 编程" />
  </entry>
  <entry>
    <title>Atom 条目二</title>
    <link rel="alternate" href="https://example.com/atom/2" />
    <published>2026-09-25T20:00:00Z</published>
    <content type="html">&lt;p&gt;Atom 正文二&lt;/p&gt;</content>
  </entry>
</feed>`;

// RSS 1.0 / RDF 样例（只做解析器单测，不经过 HTTP）
const RDF_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/rdf"><title>RDF 测试源</title></channel>
  <item rdf:about="https://example.com/rdf/1"><title>RDF 条目</title><link>https://example.com/rdf/1</link><dc:date>2026-09-24T10:00:00Z</dc:date></item>
</rdf:RDF>`;

let lastRequest = null;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/nested") {
    lastRequest = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    const firstScore = url.searchParams.get("score") === "high" ? 99 : 11;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      data: {
        groups: [
          {
            items: [
              {
                name: "甲",
                score: firstScore,
                desc: "甲的摘要",
                from: { name: "来源甲" },
                links: { original: "https://example.com/origin-a" },
                publishedAt: "2026-09-26T04:54:05.000Z",
                link: "https://example.com/a",
              },
              { name: "乙", score: 22 },
            ],
          },
          { items: [{ name: "丙", score: 33 }, { name: "", score: 44 }] },
        ],
      },
    }));
    return;
  }
  const daily = /^\/dailies\/([^/]+)$/.exec(url.pathname);
  if (daily !== null) {
    lastRequest = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ date: daily[1], report: { items: [{ title: `日报 ${daily[1]}` }] } }));
    return;
  }
  if (url.pathname === "/feed.xml") {
    lastRequest = { query: Object.fromEntries(url.searchParams), headers: req.headers };
    res.setHeader("content-type", "application/rss+xml; charset=utf-8");
    res.end(RSS_SAMPLE);
    return;
  }
  if (url.pathname === "/atom.xml") {
    res.setHeader("content-type", "application/atom+xml; charset=utf-8");
    res.end(ATOM_SAMPLE);
    return;
  }
  if (url.pathname === "/notafeed") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><body><h1>这是一个网页，不是 feed</h1></body></html>");
    return;
  }
  if (url.pathname === "/many") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: Array.from({ length: 25 }, (_, i) => ({ name: `条目${i + 1}` })) }));
    return;
  }
  if (url.pathname === "/badjson") {
    res.end("<html><body>风控页</body></html>");
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// ── 临时覆盖层清单 ────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "dsh-info-sources-"));
const userPath = join(dir, "info-sources.json");
writeFileSync(userPath, `${JSON.stringify({
  version: 1,
  _comment: "测试用覆盖层",
  sources: [
    {
      id: "local-nested",
      label: "本地嵌套接口",
      method: "api-get",
      url: `http://127.0.0.1:${port}/nested`,
      query: { tab: "from-config", keep: "1" },
      headers: { "X-Test": "yes", "X-Optional": "$ENV:NOT_SET_AT_ALL?" },
      select: {
        items: "data.wrong[]",
        itemsFallback: ["data.groups[].items[]"],
        title: "name",
        hot: "score",
        url: "link",
        summary: "desc",
        origin: "from.name",
        originalUrl: "links.original",
        publishedAt: "publishedAt",
      },
      limit: 2,
    },
    {
      id: "local-daily",
      label: "本地路径参数接口",
      url: `http://127.0.0.1:${port}/dailies/{date}`,
      query: { fields: "minimal" },
      select: { items: "report.items[]", title: "title" },
    },
    { id: "local-feed", label: "本地 RSS 源", method: "rss", url: `http://127.0.0.1:${port}/feed.xml`, limit: 0 },
    { id: "local-atom", label: "本地 Atom 源", method: "rss", url: `http://127.0.0.1:${port}/atom.xml`, limit: 0 },
    { id: "local-nolimit", label: "自己不写 limit 的源", url: `http://127.0.0.1:${port}/many`, select: { items: "items[]", title: "name" } },
    { id: "local-notfeed", label: "本地非 feed", method: "rss", url: `http://127.0.0.1:${port}/notafeed` },
    { id: "local-404", label: "本地 404", url: `http://127.0.0.1:${port}/missing`, select: { title: "x" } },
    { id: "local-badjson", label: "本地非 JSON", url: `http://127.0.0.1:${port}/badjson`, select: { title: "x" } },
    { id: "dedupe-low", label: "去重低热度", url: `http://127.0.0.1:${port}/nested`, query: { score: "low" }, select: { items: "data.groups[].items[]", title: "name", hot: "score" }, limit: 1 },
    { id: "dedupe-high", label: "去重高热度", url: `http://127.0.0.1:${port}/nested`, query: { score: "high" }, select: { items: "data.groups[].items[]", title: "name", hot: "score" }, limit: 1 },
    { id: "broken-method", label: "方式不存在", method: "no-such-method", url: "https://example.com", select: { title: "x" } },
    { id: "broken-url", label: "协议不对", url: "ftp://example.com", select: { title: "x" } },
    { id: "needs-env", label: "必填环境变量缺失", enabled: false, url: "https://example.com", headers: { Authorization: "$ENV:DEFINITELY_NOT_SET" }, select: { title: "x" } },
  ],
  _disabled: [
    { id: "parked-source", label: "被注释掉的测试源", method: "rss", url: "https://example.com/feed" },
  ],
}, null, 2)}\n`, "utf8");
// 测试期间的落盘一律进临时目录，别往工作区丢文件
const outDir = join(dir, "collections");
process.env.DSH_INFO_OUTPUT_DIR = outDir;

// ── A. 注册 ───────────────────────────────────────────────────────────────
section("A. 工具注册与 schema 编译");
const registered = new Map();
const fakeCtx = { tools: { register(definition) { registered.set(definition.name, definition); return () => {}; } } };
const mod = await import("../lib/index.js");
mod.apply(fakeCtx);

const toolNames = ["info_sources", "info_fetch", "info_collect", "info_reload", "info_source_save"];
for (const name of toolNames) {
  const tool = registered.get(name);
  check(`注册 ${name}`, tool !== undefined);
  if (tool === undefined) continue;
  check(`  ${name} 参数 schema 是 object`, tool.parameters?.type === "object", JSON.stringify(tool.parameters)?.slice(0, 120));
  check(`  ${name} 输出 schema 已编译`, typeof tool.output?.schema === "object" && typeof tool.output?.render === "function");
}

const call = async (name, args) => {
  const tool = registered.get(name);
  return await tool.execute({ sourcesPath: userPath, ...args }, { signal: new AbortController().signal });
};

/** 带会话上下文的调用：exec.agent.session.header.cwd 就是会话工作区 */
const callAs = async (name, args, sessionCwd) => {
  const tool = registered.get(name);
  return await tool.execute({ sourcesPath: userPath, ...args }, {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: sessionCwd } } },
  });
};
const rendered = (name, args, value) => registered.get(name).output.render(args, value)[0].text;

// ── D. 清单校验 ───────────────────────────────────────────────────────────
section("D. 清单校验（问题要报出来，而不是静默忽略）");
const reloaded = await call("info_reload", {});
const issueOf = (id) => reloaded.issues.filter((issue) => issue.id === id);
const builtinOnly = await registered.get("info_reload").execute({}, { signal: new AbortController().signal });
check("未传 sourcesPath 时只使用包内默认源", builtinOnly.total === 2 && builtinOnly.userExists === false && builtinOnly.user === undefined, JSON.stringify(builtinOnly));
check("unknown method 被报错", issueOf("broken-method").some((issue) => issue.level === "error" && issue.message.includes("no-such-method")));
check("非 http url 被报错", issueOf("broken-url").some((issue) => issue.level === "error" && issue.message.includes("http")));
check("必填环境变量缺失被报错", issueOf("needs-env").some((issue) => issue.level === "error" && issue.message.includes("DEFINITELY_NOT_SET")));
check("可选环境变量缺失只警告", issueOf("local-nested").some((issue) => issue.level === "warn" && issue.message.includes("NOT_SET_AT_ALL")));

section("D. 包内示例清单 = 一个 api-get + 一个 rss；_disabled 机制照旧");
const builtinDoc = JSON.parse(readFileSync(new URL("../config/sources.json", import.meta.url), "utf8"));
const builtinIds = builtinDoc.sources.map((entry) => entry.id);
const packagedDisabled = (builtinDoc._disabled ?? []).map((entry) => entry.id);
check("包内只带两个示例源（一个 api-get + 一个 rss）", builtinIds.length === 2 && builtinIds.includes("aihot-daily") && builtinIds.includes("qbitai-feed"), builtinIds.join(", "));
check("两个示例分别覆盖 api-get 与 rss", builtinDoc.sources.map((entry) => entry.method).sort().join(",") === "api-get,rss", builtinDoc.sources.map((entry) => entry.method).join(","));
check("两个示例都写了显式 limit 20", builtinDoc.sources.every((entry) => entry.limit === 20), JSON.stringify(builtinDoc.sources.map((e) => [e.id, e.limit])));
check("api-get 示例保留 select 映射（当写法学样例）", typeof builtinDoc.sources.find((entry) => entry.method === "api-get")?.select?.title === "string");
check("包内示例不带 _disabled 块", packagedDisabled.length === 0, packagedDisabled.join(", "));
const listedAll = await call("info_sources", { includeDisabled: true });
check("覆盖层里的 _disabled 不被解析成源", !listedAll.sources.some((source) => source.id === "parked-source"), listedAll.sources.map((s) => s.id).join(", "));
check("info_sources 报出被注释的源", listedAll.commentedOut.join(",") === "parked-source", JSON.stringify(listedAll.commentedOut));
check("被注释的源也确实取不到", (await call("info_fetch", { id: "parked-source", save: false })).error.includes("清单里没有 id"));
check("清单总数 = 包内两例 + 覆盖层 13 源", reloaded.total === builtinIds.length + 13, `total=${reloaded.total} 期望=${builtinIds.length + 13}`);
check("两种采集方式都已注册", listedAll.methods.map((method) => method.id).join(",") === "api-get,rss", listedAll.methods.map((method) => method.id).join(","));
check("包内两个示例都通过清单校验", listedAll.sources.filter((source) => builtinIds.includes(source.id)).every((source) => source.ok === true), JSON.stringify(listedAll.sources.filter((s) => builtinIds.includes(s.id)).map((s) => [s.id, s.ok])));
console.log(rendered("info_reload", {}, reloaded).split("\n").slice(0, 6).join("\n"));

// ── C + B. 覆盖层写入与本地接口 ───────────────────────────────────────────
section("B. 本地接口：字段映射 / 回退路径 / query / 可选请求头 / limit");
const nested = await call("info_fetch", { id: "local-nested" });
check("取数成功", nested.ok === true, nested.error);
check("命中 itemsFallback", nested.matchedPath === "data.groups[].items[]", String(nested.matchedPath));
check("limit=2 生效", nested.count === 2 && nested.rawCount === 3, `count=${nested.count} rawCount=${nested.rawCount}`);
check("title/hot 映射正确", nested.items[0]?.title === "甲" && nested.items[0]?.hot === 11, JSON.stringify(nested.items[0]));
check("空标题条目被丢弃", nested.items.every((item) => item.title !== ""));
check("url 字段映射正确", nested.items[0]?.url === "https://example.com/a");
check("摘要映射正确", nested.items[0]?.summary === "甲的摘要");
check("出处映射正确", nested.items[0]?.origin === "来源甲");
check("原文链接映射正确", nested.items[0]?.originalUrl === "https://example.com/origin-a");
check("发布时间映射正确", nested.items[0]?.publishedAt === "2026-09-26T04:54:05.000Z");
check("没有值的字段不写键", nested.items[1]?.summary === undefined && nested.items[1]?.origin === undefined);
check("配置里的 query 带上", lastRequest?.query?.tab === "from-config" && lastRequest?.query?.keep === "1", JSON.stringify(lastRequest?.query));
check("普通请求头带上", lastRequest?.headers?.["x-test"] === "yes");
check("可选 $ENV 请求头缺失时被丢弃", lastRequest?.headers?.["x-optional"] === undefined, JSON.stringify(lastRequest?.headers?.["x-optional"]));
console.log(rendered("info_fetch", { id: "local-nested" }, nested));

const overridden = await call("info_fetch", { id: "local-nested", params: { tab: "from-call" }, limit: 1 });
check("params 覆盖清单 query", overridden.url.includes("tab=from-call") && overridden.url.includes("keep=1"), overridden.url);
check("调用参数 limit 覆盖清单 limit", overridden.count === 1, `count=${overridden.count}`);

section("B. {key} 路径参数");
const daily = await call("info_fetch", { id: "local-daily", params: { date: "2026-09-25" } });
check("路径参数替换进 URL", daily.ok === true && daily.url.includes("/dailies/2026-09-25"), daily.url ?? daily.error);
check("路径参数不重复出现在查询串", !daily.url.includes("date="), daily.url);
check("其余 query 仍在", daily.url.includes("fields=minimal"), daily.url);
check("取到对应数据", daily.items[0]?.title === "日报 2026-09-25", JSON.stringify(daily.items[0]));
const dailyMissing = await call("info_fetch", { id: "local-daily" });
check("路径参数缺值给出明确错误", dailyMissing.ok === false && dailyMissing.error.includes("路径参数缺值"), dailyMissing.error);

section("B. 失败路径：不抛异常，返回可读原因");
const notFound = await call("info_fetch", { id: "local-404" });
check("404 → ok=false + 状态码", notFound.ok === false && notFound.error.includes("404"), notFound.error);
const badJson = await call("info_fetch", { id: "local-badjson" });
check("非 JSON → ok=false + 片段", badJson.ok === false && badJson.error.includes("不是 JSON"), badJson.error);
const unknown = await call("info_fetch", { id: "no-such-source" });
check("未知 id → 列出可用 id", unknown.ok === false && unknown.error.includes("可用："), unknown.error);
const collectFail = await call("info_collect", { ids: "local-nested,local-404" });
check("多源：部分失败仍返回成功源的数据", collectFail.results.length === 2 && collectFail.total === 2 && collectFail.ok === false);
check("多源：保留各源请求 URL 与 HTTP 状态", collectFail.results.every((entry) => typeof entry.url === "string" && typeof entry.status === "number"), JSON.stringify(collectFail.results));
const invalidSource = await call("info_fetch", { id: "needs-env", save: false });
check("配置校验失败的源不会进入适配器", invalidSource.ok === false && invalidSource.error.includes("配置校验未通过"), invalidSource.error);
const deduped = await call("info_collect", { ids: "dedupe-low,dedupe-high", dedupe: "title", save: false });
check("高热度条目替换后 alsoFrom 指向旧来源而非自己", deduped.items[0]?.sourceId === "dedupe-high" && JSON.stringify(deduped.items[0]?.alsoFrom) === JSON.stringify(["dedupe-low"]), JSON.stringify(deduped.items[0]));
const collectNone = await call("info_collect", { ids: "nope" });
check("多源：无匹配源给出提示", collectNone.ok === false && collectNone.note.includes("没有匹配的源"), collectNone.note);
const collectAi = await call("info_collect", { tag: "ai" });
check("多源：按 tag 能选中 AIHOT 源", collectAi.requested >= 2, `requested=${collectAi.requested}`);

// 回归：源自己不写 limit 时，defaults.limit 必须在 info_fetch 和 info_collect 两条路径上都生效
// （曾经 collect() 忘传 defaults，导致 info_collect 完全不受 defaults.limit 约束）
const noLimitFetch = await call("info_fetch", { id: "local-nolimit", save: false });
check("源没写 limit 时 info_fetch 用 defaults.limit 收口", noLimitFetch.count === 20 && noLimitFetch.rawCount === 25, `count=${noLimitFetch.count} rawCount=${noLimitFetch.rawCount}`);
const noLimitCollect = await call("info_collect", { ids: "local-nolimit", save: false });
check("源没写 limit 时 info_collect 也用 defaults.limit 收口（回归）", noLimitCollect.total === 20, `total=${noLimitCollect.total}`);
check("汇总结果里该源的条数同样是 20", noLimitCollect.results[0]?.count === 20, JSON.stringify(noLimitCollect.results[0]));
check("effectiveLimit 的三种情形", effectiveLimit({}, { limit: 20 }) === 20 && effectiveLimit({}, { limit: 0 }) === 0 && effectiveLimit({ limit: 0 }, { limit: 20 }) === 0, `${effectiveLimit({}, { limit: 20 })}/${effectiveLimit({}, { limit: 0 })}/${effectiveLimit({ limit: 0 }, { limit: 20 })}`);
check("tag=tech 没有匹配的源（示例里不带 tech 标签，提示可见）", (await call("info_collect", { tag: "tech", save: false })).requested === 0);
check("tag=ai 选中包内两个示例", (await call("info_collect", { tag: "ai", save: false })).requested === 2);

section("C. 覆盖层维护（程序方式增删改）");
// 用包内的示例源做停用/恢复往返，验证覆盖层与默认层的合并方向
const saved = await call("info_source_save", { id: "aihot-daily", patch: { enabled: false } });
check("写入覆盖文件", saved.action === "upsert" && saved.path === userPath, saved.path);
const afterDisable = await call("info_sources", { includeDisabled: true });
const disabledDaily = afterDisable.sources.find((source) => source.id === "aihot-daily");
check("包内源被覆盖层停用", disabledDaily?.enabled === false && disabledDaily?.origin === "user", JSON.stringify(disabledDaily));
check("覆盖字段被记录", JSON.stringify(disabledDaily?.overrides) === JSON.stringify(["enabled"]), JSON.stringify(disabledDaily?.overrides));
check("文件里其它条目未被破坏", JSON.parse(readFileSync(userPath, "utf8")).sources.length === 14, String(JSON.parse(readFileSync(userPath, "utf8")).sources.length));
const removed = await call("info_source_save", { id: "aihot-daily", remove: true });
const afterRemove = await call("info_sources", {});
const restoredDaily = afterRemove.sources.find((source) => source.id === "aihot-daily");
check("删除覆盖条目后回到默认层", removed.action === "remove" && restoredDaily?.enabled === true && restoredDaily?.origin === "builtin", JSON.stringify(restoredDaily));

// ── E. 真接口冒烟 ─────────────────────────────────────────────────────────
section("E. 真接口冒烟");
if (process.argv.includes("--live")) {
  const dailyLive = await call("info_fetch", { id: "aihot-daily", limit: 3 });
  softCheck("日报可取数", dailyLive.ok === true && dailyLive.count === 3, dailyLive.error);
  if (dailyLive.ok) {
    softCheck("日报带摘要", dailyLive.items.every((item) => typeof item.summary === "string" && item.summary.length > 0));
    softCheck("日报带原文链接与出处", dailyLive.items.every((item) => item.originalUrl !== undefined && item.origin !== undefined));
    console.log(rendered("info_fetch", { id: "aihot-daily", limit: 3 }, dailyLive));
  }
  const qbitai = await call("info_fetch", { id: "qbitai-feed", limit: 5 });
  softCheck("RSS 源（量子位）可取数", qbitai.ok === true && qbitai.count === 5, qbitai.error);
  if (qbitai.ok) console.log(rendered("info_fetch", { id: "qbitai-feed", limit: 5 }, qbitai));
  const live = await call("info_collect", { tag: "ai", limit: 10 });
  softCheck("多源汇总可取数", live.total > 0, live.note ?? live.results.map((entry) => entry.error).join(" | "));
  if (live.total > 0) console.log(rendered("info_collect", { tag: "ai" }, live));
} else {
  console.log("  – 已跳过；用 npm run test:live 执行");
}

const listed = await call("info_sources", { includeDisabled: true });
console.log(`\n${rendered("info_sources", { includeDisabled: true }, listed)}`);

// ── G. RSS 方式 ───────────────────────────────────────────────────────────
section("G. RSS 方式：解析器单测");
const rssFeed = parseFeed(RSS_SAMPLE);
check("识别 RSS 2.0", rssFeed?.format === "rss" && rssFeed.items.length === 4, String(rssFeed?.format));
check("feed 标题解码实体", rssFeed?.title === "测试订阅源 & 示例", rssFeed?.title);
check("CDATA 标题原样保留", rssFeed?.items[0].title === "带 CDATA 的标题 & 特殊字符 <标签>", rssFeed?.items[0].title);
check("命名实体与数字实体都解码", rssFeed?.items[1].title === "实体与数字引用 & 中文", rssFeed?.items[1].title);
check("dc:creator 认作作者", rssFeed?.items[1].author === "作者乙", rssFeed?.items[1].author);
check("content:encoded 回退为描述（原始 HTML 交给渲染层剥）", rssFeed?.items[2].description === "<p>正文摘要来自 content:encoded</p>", rssFeed?.items[2].description);
check("RFC822 时间转 ISO", rssFeed?.items[0].publishedAt === "2026-09-26T07:34:48.000Z" && rssFeed?.items[1].publishedAt === "2026-09-25T08:00:00.000Z", `${rssFeed?.items[0].publishedAt} / ${rssFeed?.items[1].publishedAt}`);
check("category 保留 domain 属性与文本", JSON.stringify(rssFeed?.items[0].categories) === JSON.stringify([{ text: "AI" }, { text: "example.com", domain: "source" }]), JSON.stringify(rssFeed?.items[0].categories));

const atomFeed = parseFeed(ATOM_SAMPLE);
check("识别 Atom", atomFeed?.format === "atom" && atomFeed.items.length === 2, String(atomFeed?.format));
check("Atom link 取 rel=alternate 或无 rel 的那条", atomFeed?.items[0].link === "https://example.com/atom/1" && atomFeed?.items[1].link === "https://example.com/atom/2", `${atomFeed?.items[0].link} / ${atomFeed?.items[1].link}`);
check("Atom author/name 与 published/updated", atomFeed?.items[0].author === "Atom 作者" && atomFeed?.items[0].publishedAt === "2026-09-26T08:00:00.000Z" && atomFeed?.items[1].publishedAt === "2026-09-25T20:00:00.000Z", String(atomFeed?.items[0].author));
check("Atom category term 作为分类", atomFeed?.items[0].categories[0].text === "AI 编程", JSON.stringify(atomFeed?.items[0].categories));
check("转义 HTML 正文能被还原", atomFeed?.items[1].description === "<p>Atom 正文二</p>", atomFeed?.items[1].description);

const rdfFeed = parseFeed(RDF_SAMPLE);
check("识别 RSS 1.0 / RDF", rdfFeed?.format === "rdf" && rdfFeed.items.length === 1 && rdfFeed.items[0].publishedAt === "2026-09-24T10:00:00.000Z", String(rdfFeed?.format));
check("非 feed 内容返回 null", parseFeed("<html><body>hi</body></html>") === null);
check("stripHtml 压成一行", stripHtml("<p>a<br>b</p>\n  <b>c</b>") === "a b c", stripHtml("<p>a<br>b</p>\n  <b>c</b>"));
check("textFromHtml 先解实体再剥标签", textFromHtml("<p>第一段&nbsp;描述</p>") === "第一段 描述", textFromHtml("<p>第一段&nbsp;描述</p>"));
check("decodeEntities 处理十六进制与非法码点", decodeEntities("&#x4E2D;&#65;&#xZZ;&amp;") === "中A&#xZZ;&", decodeEntities("&#x4E2D;&#65;&#xZZ;&amp;"));

section("G. RSS 方式：走 HTTP 的完整链路");
const feed = await call("info_fetch", { id: "local-feed", save: false });
check("RSS 源取数成功", feed.ok === true && feed.count === 4, feed.error);
check("方法与命中路径标记正确", feed.method === "rss" && feed.matchedPath === "rss:item", `${feed.method} / ${feed.matchedPath}`);
check("标题与链接映射正确", feed.items[0].title === "带 CDATA 的标题 & 特殊字符 <标签>" && feed.items[0].url === "https://example.com/posts/1", feed.items[0].title);
check("CDATA 里的 HTML 描述被解实体并剥标签", feed.items[0].summary === "第一段 描述 第二段", feed.items[0].summary);
check("出处优先取 author", feed.items[0].origin === "作者甲", feed.items[0].origin);
check("分类取第一个非 domain 型 category", feed.items[0].label === "AI", String(feed.items[0].label));
check("没有 author 时出处退回 feed 标题", feed.items[2].origin === "测试订阅源 & 示例", feed.items[2].origin);
check("没有 author 时出处可用 domain=source 的 category", feed.items[3].origin === "bestblogs.dev" && feed.items[3].label === "资讯", `${feed.items[3].origin} / ${feed.items[3].label}`);
check("发布时间是 ISO", feed.items[0].publishedAt === "2026-09-26T07:34:48.000Z", feed.items[0].publishedAt);
check("feed 没有热度就不输出 hot", feed.items.every((item) => item.hot === undefined));
check("名次按 feed 顺序", feed.items.map((item) => item.rank).join(",") === "1,2,3,4", feed.items.map((item) => item.rank).join(","));
check("渲染里带出处", rendered("info_fetch", { id: "local-feed" }, feed).includes("作者甲"));
console.log(rendered("info_fetch", { id: "local-feed" }, feed).split("\n").slice(0, 8).join("\n"));

const atom = await call("info_fetch", { id: "local-atom", save: false });
check("Atom 源取数成功", atom.ok === true && atom.count === 2 && atom.matchedPath === "atom:item", atom.error);
check("Atom 摘要来自 summary", atom.items[0].summary === "Atom 摘要一", atom.items[0].summary);
check("Atom 摘要来自 content 时剥标签", atom.items[1].summary === "Atom 正文二", atom.items[1].summary);

const notFeed = await call("info_fetch", { id: "local-notfeed", save: false });
check("非 feed 内容给出明确错误", notFeed.ok === false && notFeed.error.includes("不是 feed"), notFeed.error);

// ── F. 落盘 ───────────────────────────────────────────────────────────────
section("F. 落盘（默认写 info_collection_<时间戳>.md）");

const stampSample = fileStamp(new Date("2026-09-26T04:54:05Z"));
check("时间戳按北京时间生成", stampSample === "20260926125405", stampSample);

const resolvedEnv = resolveOutput();
const nameOf = (file) => String(file).split(/[\\/]/).pop();
check("缺省目录取 $DSH_INFO_OUTPUT_DIR", resolve(resolvedEnv.dir) === resolve(outDir), resolvedEnv.dir);
check("缺省文件名形如 info_collection_<14 位>.md", /^info_collection_\d{14}\.md$/.test(nameOf(resolvedEnv.file)), resolvedEnv.file);

const savedEnv = process.env.DSH_INFO_OUTPUT_DIR;
delete process.env.DSH_INFO_OUTPUT_DIR;
const resolvedCwd = resolveOutput();
check("没有环境变量时退回进程 cwd", resolve(resolvedCwd.dir) === resolve(process.cwd()), resolvedCwd.dir);

const sessionRoot = join(dir, "session-workspace");
const resolvedSession = resolveOutput({ baseDir: sessionRoot });
check("给了会话工作区就落在会话工作区", resolve(resolvedSession.dir) === resolve(sessionRoot), resolvedSession.dir);
const resolvedSessionPath = resolveOutput({ baseDir: sessionRoot, path: "sub/one.md" });
check("相对 path 按会话工作区解析", resolvedSessionPath.file === resolve(sessionRoot, "sub", "one.md"), resolvedSessionPath.file);
process.env.DSH_INFO_OUTPUT_DIR = savedEnv;
check("环境变量优先于会话工作区", resolve(resolveOutput({ baseDir: sessionRoot }).dir) === resolve(outDir), resolveOutput({ baseDir: sessionRoot }).dir);

// 工具层贯通：exec 里带会话工作区时，文件必须落在那里（而不是进程 cwd）
delete process.env.DSH_INFO_OUTPUT_DIR;
const inSession = await callAs("info_fetch", { id: "local-nested" }, sessionRoot);
check("info_fetch 认 exec 带的会话工作区", resolve(inSession.file).startsWith(resolve(sessionRoot)), String(inSession.file));
const inSessionCollect = await callAs("info_collect", { ids: "local-nested" }, sessionRoot);
check("info_collect 认 exec 带的会话工作区", resolve(inSessionCollect.file).startsWith(resolve(sessionRoot)), String(inSessionCollect.file));
const originalCwd = process.cwd();
process.chdir(dir);
const noExec = await call("info_fetch", { id: "local-nested" });
process.chdir(originalCwd);
check("拿不到会话信息时退回进程 cwd", resolve(noExec.file).startsWith(resolve(dir)), String(noExec.file));
process.env.DSH_INFO_OUTPUT_DIR = savedEnv;

const resolvedDirArg = resolveOutput({ path: "collections/sub" });
check("path 是目录时在其下生成文件名", resolvedDirArg.dir.endsWith(join("collections", "sub")) && /^info_collection_\d{14}\.md$/.test(nameOf(resolvedDirArg.file)), resolvedDirArg.file);
const resolvedFileArg = resolveOutput({ path: "collections/one.md" });
check("path 是 .md 时按文件名处理", resolvedFileArg.file.endsWith("one.md") && resolvedFileArg.generated === false, resolvedFileArg.file);

// 用本地源做确定性断言，不依赖网络
const before = existsSync(outDir) ? readdirSync(outDir).length : 0;
const fetched = await call("info_fetch", { id: "local-nested" });
check("取数结果带出 file 字段", typeof fetched.file === "string" && fetched.file.endsWith(".md"), String(fetched.file));
check("落在默认目录下", resolve(fetched.file).startsWith(resolve(outDir)), fetched.file);
check("文件名符合约定", /^info_collection_\d{14}(_\d+)?\.md$/.test(nameOf(fetched.file)), nameOf(fetched.file));
const body = readFileSync(fetched.file, "utf8");
check("markdown 有标题与条目数", body.includes("# 本地嵌套接口（local-nested）采集结果") && body.includes("## 条目（2 条）"), body.split("\n")[0]);
check("markdown 带来源小节与请求 URL", body.includes("## 来源") && body.includes("/nested?tab=from-config"));
check("markdown 带出处/原文/摘要", body.includes("- **出处**：来源甲") && body.includes("- **原文**：https://example.com/origin-a") && body.includes("**摘要**：甲的摘要"));
check("markdown 带发布时间与北京时间换算", body.includes("2026-09-26T04:54:05.000Z") && body.includes("北京时间 09-26 12:54"));
check("渲染文本里给出落盘路径", rendered("info_fetch", { id: "local-nested" }, fetched).includes("已落盘："));
check("每次取数新增一个文件", readdirSync(outDir).length === before + 1, `${before} → ${readdirSync(outDir).length}`);

const noSaveBefore = readdirSync(outDir).length;
const notSaved = await call("info_fetch", { id: "local-nested", save: false });
check("save=false 不写文件", notSaved.file === undefined && readdirSync(outDir).length === noSaveBefore, String(notSaved.file));

const explicitDir = join(dir, "explicit");
const inDir = await call("info_fetch", { id: "local-nested", path: explicitDir });
check("path 指定目录时写进该目录", resolve(inDir.file).startsWith(resolve(explicitDir)), inDir.file);

const explicitFile = join(dir, "my-collection.md");
const inFile = await call("info_fetch", { id: "local-nested", path: explicitFile });
const inFileAgain = await call("info_fetch", { id: "local-nested", path: explicitFile });
check("path 指定 .md 时写该文件", inFile.file === explicitFile, inFile.file);
check("显式 .md 路径按调用方意图覆盖（不加 _2）", inFileAgain.file === explicitFile && existsSync(explicitFile), inFileAgain.file);

const collided = writeCollection({ heading: "撞名测试", items: [], now: new Date("2026-09-26T04:54:05Z"), path: join(dir, "collide") });
const collided2 = writeCollection({ heading: "撞名测试", items: [], now: new Date("2026-09-26T04:54:05Z"), path: join(dir, "collide") });
check("自动命名撞名时退让为 _2", nameOf(collided.file) === "info_collection_20260926125405.md" && nameOf(collided2.file) === "info_collection_20260926125405_2.md", `${nameOf(collided.file)} / ${nameOf(collided2.file)}`);

const collected = await call("info_collect", { ids: "local-nested,local-404" });
const collectBody = typeof collected.file === "string" ? readFileSync(collected.file, "utf8") : "";
check("汇总也落盘并记录各源成败", collectBody.includes("✓ **本地嵌套接口**") && collectBody.includes("✗ **本地 404**"), String(collected.file));
check("汇总落盘带来源小节", collectBody.includes("## 来源") && collectBody.includes("## 条目（2 条）"));

// ── 收尾 ──────────────────────────────────────────────────────────────────
server.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${failures === 0 ? "全部通过" : `${failures} 项失败`}${warnings > 0 ? `，${warnings} 项网络相关跳过` : ""}`);
process.exit(failures === 0 ? 0 : 1);
