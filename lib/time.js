/**
 * lib/time.js — 时间窗工具（香港时区）
 *
 * 免费 OpenAlex 计划不能用 from_created_date（付费 sync 过滤器），
 * 所以窗口一律用 from_publication_date / to_publication_date，按「月」对齐。
 */

export const HK_OFFSET_MS = 8 * 3600 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** 香港时区的今天（YYYY-MM-DD）。 */
export function hkToday() {
  const d = new Date(Date.now() + HK_OFFSET_MS);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * 默认窗口：从「N 个月前」的 1 日到「本月最后一天」（香港日期）。
 * monthsBack=1 → 上月 1 日—本月末（原始方案）；2 → 上上月起。
 * 不按天滚动，因为大量期刊只精确到「年月」。
 */
export function defaultWindow(monthsBack = 1) {
  const now = new Date(Date.now() + HK_OFFSET_MS);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const back = Math.min(Math.max(Math.floor(Number(monthsBack) || 1), 1), 12);
  const start = new Date(Date.UTC(year, month - back, 1));
  const from = ymd(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const to = ymd(year, month + 1, lastDay);
  return { from, to };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 解析并校验用户传入的时间窗；缺省用 defaultWindow(monthsBack)。 */
export function resolveWindow(input, monthsBack = 1) {
  const base = defaultWindow(monthsBack);
  const from = typeof input?.from === 'string' && input.from.trim() !== '' ? input.from.trim() : base.from;
  const to = typeof input?.to === 'string' && input.to.trim() !== '' ? input.to.trim() : base.to;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new Error(`时间窗格式必须是 YYYY-MM-DD（收到 from=${from} to=${to}）`);
  }
  if (from > to) throw new Error(`时间窗起点晚于终点（from=${from} to=${to}）`);
  return { from, to };
}
