const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TIME_ZONE_OFFSETS = { 'Asia/Shanghai': 8 * 60, 'Asia/Tokyo': 9 * 60 };
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const invalid = detail => new Error(`采集时段设置不正确：${detail}`);
const minuteOfDay = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export function validateCollectionSchedule(input) {
  if (input === undefined) return {
    enabled: false, timeZone: 'Asia/Shanghai', windows: [{ start: '09:00', end: '23:00' }]
  };
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(key => !['enabled', 'timeZone', 'windows'].includes(key))) throw invalid('请提供完整设置');
  if (typeof input.enabled !== 'boolean') throw invalid('启用状态必须为布尔值');
  if (typeof input.timeZone !== 'string' || !Object.hasOwn(TIME_ZONE_OFFSETS, input.timeZone)) throw invalid('请选择北京时间或日本时间');
  if (!Array.isArray(input.windows) || input.windows.length < 1 || input.windows.length > 8) throw invalid('请设置 1 至 8 个采集时段');
  const windows = Array.from(input.windows, window => {
    if (!window || typeof window !== 'object' || Array.isArray(window) ||
      Object.keys(window).some(key => !['start', 'end'].includes(key)) ||
      typeof window.start !== 'string' || typeof window.end !== 'string' ||
      !timePattern.test(window.start) || !timePattern.test(window.end)) throw invalid('时间须为两位小时和分钟，例如09:00');
    if (window.start === window.end) throw invalid('开始和结束时间不能相同');
    return { start: window.start, end: window.end };
  });
  return { enabled: input.enabled, timeZone: input.timeZone, windows };
}

// These two supported zones use fixed UTC offsets. No host locale or time zone
// participates in deciding whether the remote collector may access Mercari.
export function collectionScheduleStatus(schedule, now = Date.now()) {
  const validated = validateCollectionSchedule(schedule);
  if (!validated.enabled) return { allowed: true, nextChangeAt: null };
  if (typeof now !== 'number' || !Number.isFinite(now)) throw invalid('当前时间无效');
  const windows = validated.windows.map(({ start, end }) => [minuteOfDay(start), minuteOfDay(end)]);
  const allowedAt = minute => windows.some(([start, end]) => start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end);
  const offset = TIME_ZONE_OFFSETS[validated.timeZone] * MINUTE_MS;
  const dayStart = Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
  const minute = Math.floor((now - dayStart) / MINUTE_MS);
  // Only union boundaries count. Adjacent/overlapping windows and a midnight
  // crossed by an overnight window must not interrupt an in-flight request.
  const transitions = [...new Set(windows.flat())].filter(boundary =>
    allowedAt(boundary) !== allowedAt((boundary + 1439) % 1440));
  const nextChanges = transitions.map(boundary => {
    const at = dayStart + boundary * MINUTE_MS;
    return at > now ? at : at + DAY_MS;
  });
  return { allowed: allowedAt(minute), nextChangeAt: nextChanges.length ? Math.min(...nextChanges) : null };
}
