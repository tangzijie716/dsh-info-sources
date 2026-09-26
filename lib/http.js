/**
 * 采集方式共用的 HTTP 层：UA 轮换、超时与取消信号、字符集嗅探、URL 组装。
 * 任何适配器都可以只用这一层，不必各自 import 一个 HTTP 客户端。
 */

/** 每次请求随机挑一个 UA（不复用固定 UA，降低被单 UA 限流的概率） */
const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

const DEFAULT_TIMEOUT_MS = 15000;

function randomUA() {
  const index = Math.floor(Math.random() * UA_POOL.length);
  return UA_POOL[index] ?? UA_POOL[0];
}

/** 出错时截一段响应体，便于判断是限流页 / 风控页 / HTML 错误页 */
export function snippet(text, max = 160) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 从 Content-Type 或 XML 声明里嗅探字符集（中文 feed 里 GBK/GB2312 仍常见）。
 * 嗅探不出来就按 UTF-8 处理。
 */
function sniffCharset(contentType, buffer) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? "");
  if (fromHeader !== null) return fromHeader[1];
  const head = buffer.subarray(0, 200).toString("latin1");
  const fromDecl = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  return fromDecl === null ? "utf-8" : fromDecl[1];
}

/** 用嗅探到的字符集解码；TextDecoder 不可用时退回 UTF-8 */
function decodeBody(buffer, charset) {
  try {
    // TextDecoder 默认会剥掉 BOM
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/**
 * 发一次 GET，超时与外部取消信号都生效；网络/超时错误不抛，折叠成 { ok: false }。
 * @returns {{ ok: true, status, body, charset } | { ok: false, status, error }}
 */
export async function request(url, { headers, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": randomUA(), ...headers },
      redirect: "follow",
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const charset = sniffCharset(response.headers.get("content-type"), buffer);
    const body = decodeBody(buffer, charset);
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}：${snippet(body)}`, body };
    }
    return { ok: true, status: response.status, body, charset };
  } catch (error) {
    const message = timedOut ? `请求超时（${timeoutMs}ms）` : String(error?.message ?? error);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
    if (signal !== undefined && signal !== null) signal.removeEventListener("abort", forwardAbort);
  }
}

/**
 * 拼最终 URL：
 *   - url 里的 `{key}` 占位符用 params 里的同名值替换（路径参数，如 /dailies/{date}），缺值就报错；
 *   - 其余参数并入查询串：清单里的 query 打底，调用时的 params 覆盖同名；
 *   - 清单 url 自带的查询串保留。
 */
export function buildUrl(source, params = {}) {
  const merged = { ...(source.query ?? {}), ...(params ?? {}) };
  const used = new Set();
  const raw = String(source.url).replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, key) => {
    const value = merged[key];
    if (value === undefined || value === null || value === "") return match;
    used.add(key);
    return encodeURIComponent(String(value));
  });
  const missing = [...raw.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]);
  if (missing.length > 0) throw new Error(`URL 里的路径参数缺值：${[...new Set(missing)].join(", ")}（用 params 传）`);

  const url = new URL(raw);
  for (const [key, value] of Object.entries(merged)) {
    if (used.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
