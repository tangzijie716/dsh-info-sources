/**
 * 取值路径工具 —— 清单里 `select.items` / `select.title` 这些字符串由这里解释。
 *
 * 路径语法（故意做得很小，够用且可校验）：
 *   a.b.c         逐级取属性
 *   a.b[]         取数组 b 的每个元素（可串联：data.cards[].content[].content[]）
 *   a.b[0]        取数组 b 的第 0 个元素
 *   数组下标作用在非数组上时宽容跳过，不抛错（清单写错由校验层报，而不是运行时炸）
 */

/** 把路径拆成「属性名 + 方括号链」的段 */
const SEGMENT = /^([^[\]]*)((?:\[\d*\])*)$/;

/**
 * 按路径取出全部命中节点。
 * @param root 根节点（通常是接口返回的 JSON）
 * @param path 取值路径；为空时：根是数组就返回其元素，否则返回根本身
 * @returns 命中节点数组（可能为空）
 */
export function selectNodes(root, path) {
  if (path === undefined || path === null || String(path).trim() === "") {
    return Array.isArray(root) ? root : [root];
  }
  let nodes = [root];
  for (const raw of String(path).split(".")) {
    const segment = raw.trim();
    if (segment === "") continue;
    const matched = SEGMENT.exec(segment);
    if (matched === null) return [];
    const [, name = "", brackets = ""] = matched;

    let next = [];
    for (const node of nodes) {
      if (name === "") {
        next.push(node);
        continue;
      }
      if (node === null || typeof node !== "object") continue;
      const value = node[name];
      if (value !== undefined) next.push(value);
    }

    for (const op of brackets.match(/\[\d*\]/g) ?? []) {
      const inner = op.slice(1, -1);
      const spread = [];
      for (const node of next) {
        if (!Array.isArray(node)) continue;
        if (inner === "") spread.push(...node);
        else {
          const index = Number(inner);
          if (Number.isInteger(index) && index >= 0 && index < node.length) spread.push(node[index]);
        }
      }
      next = spread;
    }
    nodes = next;
    if (nodes.length === 0) return [];
  }
  return nodes;
}

/**
 * 从一个条目里按相对路径取单个值。
 * @param node 条目节点
 * @param path 相对路径（同 select 语法；数组命中时取第一个）
 * @returns 值，或 undefined
 */
export function getField(node, path) {
  if (path === undefined || path === null || path === "") return undefined;
  const hits = selectNodes(node, path);
  return hits.length > 0 ? hits[0] : undefined;
}

/** 取字符串：null/undefined 归为 undefined，其余 String() 后 trim，空串归为 undefined */
export function pickString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/** 取数字：能转成有限数就返回，否则 undefined（"1.2万" 这类非数字热度值会被丢掉） */
export function pickNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** 取整数：非整数或负数归为 undefined */
export function pickInteger(value) {
  const num = pickNumber(value);
  if (num === undefined) return undefined;
  const int = Math.trunc(num);
  return int >= 0 ? int : undefined;
}
