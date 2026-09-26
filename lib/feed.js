/**
 * 极简 XML / feed 解析 —— 零依赖。
 *
 * 为什么不用现成库：这个插件刻意不引第三方依赖（避免和别的插件共享 node_modules 里的传递依赖）。
 * feed 的 XML 子集很小，一个扫描器 + 一颗轻量树就够了；不做 DTD、不做命名空间解析，
 * 只保留限定名（`media:readingTime`、`content:encoded`）并在查找时兼容本地名。
 *
 * 支持：RSS 2.0（<rss><channel><item>）、Atom（<feed><entry>）、RSS 1.0/RDF（<rdf:RDF><item>）、
 * CDATA、实体、自闭合标签、标签内引号里的 `>`。
 */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function codePointToString(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 解码 XML 实体（含数字实体）；不认识的实体原样保留 */
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return codePointToString(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return codePointToString(Number.parseInt(body.slice(1), 10));
    const known = NAMED_ENTITIES[body.toLowerCase()];
    return known === undefined ? match : known;
  });
}

/** 剥掉 HTML 标签并把空白压成一行（feed 的描述里常是 HTML 片段） */
export function stripHtml(text) {
  return String(text ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * feed 描述 → 一行纯文本。
 * 先解实体再剥标签：CDATA 里的 HTML 是不解实体的（原样保留 `&nbsp;`、`&amp;`），
 * 而 `&lt;p&gt;` 这种转义标签也应当还原后再被剥掉。
 * 对已经被解析器解过实体的普通文本，多解一次通常无影响（`&` 孤零零时不构成实体）。
 */
export function textFromHtml(text) {
  return stripHtml(decodeEntities(text));
}

/** 找标签结束的 `>`，跳过属性值引号里的 `>` */
function findTagEnd(text, from) {
  let quote = null;
  for (let index = from + 1; index < text.length; index++) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function parseAttrs(source) {
  const attrs = {};
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function appendText(node, raw) {
  if (raw === "") return;
  node.text += decodeEntities(raw);
}

/** 扫描器式解析：返回文档根节点；无法解析的部分宽容跳过，不抛异常 */
function parseXml(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  let index = 0;

  while (index < text.length) {
    const lt = text.indexOf("<", index);
    if (lt === -1) {
      appendText(stack[stack.length - 1], text.slice(index));
      break;
    }
    if (lt > index) appendText(stack[stack.length - 1], text.slice(index, lt));

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      const raw = end === -1 ? text.slice(lt + 9) : text.slice(lt + 9, end);
      // CDATA 是原样文本，不再解实体
      stack[stack.length - 1].text += raw;
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt === -1) break;
    const inner = text.slice(lt + 1, gt).trim();
    index = gt + 1;

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = (selfClosing ? inner.slice(0, -1) : inner).trim();
    const spaceAt = body.search(/\s/);
    const name = spaceAt === -1 ? body : body.slice(0, spaceAt);
    if (name === "") continue;
    const node = {
      name,
      attrs: parseAttrs(spaceAt === -1 ? "" : body.slice(spaceAt)),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/** 限定名 → 本地名（`media:readingTime` → `readingTime`） */
function localName(name) {
  const at = String(name).indexOf(":");
  return at === -1 ? String(name) : String(name).slice(at + 1);
}

/** 找第一个子元素：先按完整名精确匹配，再退到本地名匹配 */
function child(node, ...names) {
  if (node === null || node === undefined) return null;
  for (const name of names) {
    const hit = node.children.find((entry) => entry.name === name);
    if (hit !== undefined) return hit;
  }
  for (const name of names) {
    const hit = node.children.find((entry) => localName(entry.name) === name);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** 找全部同名子元素（同上，精确优先） */
function children(node, ...names) {
  if (node === null || node === undefined) return [];
  const exact = node.children.filter((entry) => names.includes(entry.name));
  if (exact.length > 0) return exact;
  return node.children.filter((entry) => names.includes(localName(entry.name)));
}

/** 元素文本（已解实体）去掉首尾空白；没有则 undefined */
function textOf(node) {
  const value = node?.text?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** 属性值；没有则 undefined */
function attrOf(node, name) {
  const value = node?.attrs?.[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** feed 里的时间 → ISO 8601；解析不了返回原文本 */
function toIsoDate(text) {
  if (text === undefined) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

/** Atom 的 link 是属性式，且可能有多条（alternate / self / enclosure） */
function pickLink(item) {
  const nodes = children(item, "link");
  const preferred = nodes.find((node) => {
    const rel = attrOf(node, "rel");
    return rel === undefined || rel === "alternate";
  });
  const node = preferred ?? nodes[0];
  if (node === undefined) return undefined;
  return attrOf(node, "href") ?? textOf(node);
}

/**
 * 解析 feed。
 * @returns {{ format: "rss"|"atom"|"rdf", title?, link?, description?, items: Array<object> } | null}
 *          没找到 feed 根元素时返回 null
 */
export function parseFeed(input) {
  const root = parseXml(input);
  const rss = child(root, "rss");
  const atom = child(root, "feed");
  const rdf = child(root, "RDF", "rdf:RDF");
  const feedNode = rss ?? atom ?? rdf;
  if (feedNode === null) return null;
  const format = feedNode === rss ? "rss" : feedNode === atom ? "atom" : "rdf";

  const channel = child(feedNode, "channel") ?? feedNode;
  // RSS 的 item 在 channel 下；RDF 的 item 与 channel 平级；Atom 的 entry 直接在 feed 下
  const itemNodes = [
    ...children(channel, "item", "entry"),
    ...(channel === feedNode ? [] : children(feedNode, "item")),
  ];

  const items = itemNodes.map((item) => {
    const authorNode = child(item, "author", "dc:creator");
    const author = attrOf(authorNode, "name")
      ?? textOf(child(authorNode, "name"))
      ?? textOf(authorNode);
    const categories = children(item, "category")
      .map((node) => ({ text: attrOf(node, "term") ?? textOf(node), domain: attrOf(node, "domain") }))
      .filter((entry) => entry.text !== undefined || entry.domain !== undefined);
    const descriptionNode = child(item, "description")
      ?? child(item, "summary")
      ?? child(item, "content:encoded")
      ?? child(item, "content");

    return {
      title: textOf(child(item, "title")),
      link: pickLink(item),
      guid: textOf(child(item, "guid")) ?? textOf(child(item, "id")),
      description: textOf(descriptionNode),
      author,
      publishedAt: toIsoDate(
        textOf(child(item, "pubDate"))
        ?? textOf(child(item, "published"))
        ?? textOf(child(item, "updated"))
        ?? textOf(child(item, "dc:date")),
      ),
      categories,
    };
  });

  return {
    format,
    title: textOf(child(channel, "title")),
    link: pickLink(channel) ?? textOf(child(channel, "link")),
    description: textOf(child(channel, "description")) ?? textOf(child(channel, "subtitle")),
    items,
  };
}
