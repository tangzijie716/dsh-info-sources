/**
 * 清单公共字段的取值规则 —— 各个采集方式适配器共用，避免每加一种方式就抄一遍。
 */

/** 单次请求超时：源上的 timeoutMs 优先，其次 defaults.timeoutMs */
export function effectiveTimeout(source, defaults, fallback = 15000) {
  const value = Number(source?.timeoutMs ?? defaults?.timeoutMs ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 单个源最多保留多少条：0 表示不限制 */
export function effectiveLimit(source, defaults) {
  const own = source?.limit;
  if (own === undefined) {
    const fallback = Number(defaults?.limit ?? 0);
    return Number.isFinite(fallback) && fallback > 0 ? Math.trunc(fallback) : 0;
  }
  const value = Number(own);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/** 请求头合并：默认头 → defaults.headers → 源自己的 headers */
export function mergeHeaders(source, defaults, base = {}) {
  return { ...base, ...(defaults?.headers ?? {}), ...(source?.headers ?? {}) };
}
