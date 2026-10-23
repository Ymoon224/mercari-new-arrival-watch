import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCollectionSchedule, collectionScheduleStatus } from '../server/schedule.mjs';

const schedule = (windows, timeZone = 'Asia/Shanghai') => ({
  enabled: true, timeZone, windows: windows.map(([start, end]) => ({ start, end }))
});
const utc = value => Date.parse(value);

test('collection schedules default to disabled and validation returns an independent value', () => {
  const first = validateCollectionSchedule();
  assert.deepEqual(first, { enabled: false, timeZone: 'Asia/Shanghai', windows: [{ start: '09:00', end: '23:00' }] });
  first.windows[0].start = '10:00';
  assert.equal(validateCollectionSchedule().windows[0].start, '09:00');
  const input = schedule([['09:00', '23:00']]);
  const validated = validateCollectionSchedule(input);
  validated.windows[0].start = '11:00';
  assert.equal(input.windows[0].start, '09:00');
  assert.deepEqual(collectionScheduleStatus({ ...input, enabled: false }, utc('2026-10-22T23:00:00Z')),
    { allowed: true, nextChangeAt: null });
});

test('collection schedules reject malformed, unsupported and ambiguous settings', () => {
  const good = schedule([['09:00', '23:00']]);
  for (const input of [null, [], {}, { ...good, enabled: 'true' }, { ...good, enabled: 1 },
    { ...good, timeZone: 'UTC' }, { ...good, timeZone: '__proto__' }, { ...good, timeZone: new String('Asia/Shanghai') },
    { ...good, windows: [] }, { ...good, windows: Array(2) },
    { ...good, windows: Array(9).fill({ start: '09:00', end: '23:00' }) },
    { ...good, windows: [{ start: '9:00', end: '23:00' }] },
    { ...good, windows: [{ start: '24:00', end: '23:00' }] },
    { ...good, windows: [{ start: '09:60', end: '23:00' }] },
    { ...good, windows: [{ start: '09:00', end: '09:00' }] },
    { ...good, windows: [{ start: '09:00', end: '23:00', day: 1 }] },
    { ...good, timeZone: undefined }, { ...good, extra: true },
    { ...good, enabled: false, windows: [] }]) assert.throws(() => validateCollectionSchedule(input), /采集时段/);
  assert.throws(() => collectionScheduleStatus(good, NaN), /当前时间/);
});

test('daytime windows use inclusive starts, exclusive ends and exact millisecond transitions', () => {
  const settings = schedule([['09:00', '23:00']]);
  for (const [now, allowed, next] of [
    ['2026-10-23T00:59:59.999Z', false, '2026-10-23T01:00:00Z'],
    ['2026-10-23T01:00:00Z', true, '2026-10-23T15:00:00Z'],
    ['2026-10-23T14:59:59.999Z', true, '2026-10-23T15:00:00Z'],
    ['2026-10-23T15:00:00Z', false, '2026-10-24T01:00:00Z']
  ]) assert.deepEqual(collectionScheduleStatus(settings, utc(now)), { allowed, nextChangeAt: utc(next) });
});

test('overnight windows stay open across midnight and handle midnight as an endpoint', () => {
  const settings = schedule([['22:00', '06:00']]);
  assert.deepEqual(collectionScheduleStatus(settings, utc('2026-10-23T15:59:59.999Z')),
    { allowed: true, nextChangeAt: utc('2026-10-23T22:00:00Z') });
  assert.deepEqual(collectionScheduleStatus(settings, utc('2026-10-23T16:00:00Z')),
    { allowed: true, nextChangeAt: utc('2026-10-23T22:00:00Z') });
  assert.deepEqual(collectionScheduleStatus(settings, utc('2026-10-23T22:00:00Z')),
    { allowed: false, nextChangeAt: utc('2026-10-24T14:00:00Z') });
  const midnightEnd = schedule([['22:00', '00:00']]);
  assert.deepEqual(collectionScheduleStatus(midnightEnd, utc('2026-10-23T15:59:59.999Z')),
    { allowed: true, nextChangeAt: utc('2026-10-23T16:00:00Z') });
  assert.equal(collectionScheduleStatus(midnightEnd, utc('2026-10-23T16:00:00Z')).allowed, false);
});

test('overlapping and adjacent windows form a union with no artificial transition', () => {
  const settings = schedule([['09:00', '12:00'], ['11:00', '13:00'], ['13:00', '18:00'], ['22:00', '06:00']]);
  assert.deepEqual(collectionScheduleStatus(settings, utc('2026-10-23T03:59:59.999Z')),
    { allowed: true, nextChangeAt: utc('2026-10-23T10:00:00Z') });
  assert.deepEqual(collectionScheduleStatus(settings, utc('2026-10-23T10:00:00Z')),
    { allowed: false, nextChangeAt: utc('2026-10-23T14:00:00Z') });
  assert.deepEqual(collectionScheduleStatus(schedule([['22:00', '09:00'], ['06:00', '23:00']]), utc('2026-10-23T16:00:00Z')),
    { allowed: true, nextChangeAt: null });
  assert.deepEqual(collectionScheduleStatus(schedule([['00:00', '12:00'], ['12:00', '00:00']]), utc('2026-10-23T04:00:00Z')),
    { allowed: true, nextChangeAt: null });
});

test('China and Japan schedule clocks are independent of the execution host time zone', () => {
  const now = utc('2026-10-23T00:30:00Z');
  assert.deepEqual(collectionScheduleStatus(schedule([['09:00', '10:00']]), now),
    { allowed: false, nextChangeAt: utc('2026-10-23T01:00:00Z') });
  assert.deepEqual(collectionScheduleStatus(schedule([['09:00', '10:00']], 'Asia/Tokyo'), now),
    { allowed: true, nextChangeAt: utc('2026-10-23T01:00:00Z') });
});
