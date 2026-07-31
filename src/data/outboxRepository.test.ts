// @vitest-environment jsdom
//
// The queue's coalescing rule. It exists for two reasons, and both are worth
// protecting: replay stays cheap, and — more visibly — the pending count the
// user is shown before tapping Upload means "records changed", not "times you
// touched the keyboard". A count that drifts from what's about to happen
// undermines the one number this whole feature asks them to trust.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { outboxRepository } from './outboxRepository';
import type { Place } from './schema';

function place(id: string, name: string): Place {
  return {
    id,
    tripId: 'trip-1',
    name,
    city: 'Shanghai',
    lat: 31.2,
    lng: 121.4,
    status: 'wishlist',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function upsert(id: string, name: string, queuedAt = new Date().toISOString()) {
  return { entity: 'place' as const, op: 'upsert' as const, recordId: id, payload: place(id, name), queuedAt };
}

function del(id: string, queuedAt = new Date().toISOString()) {
  return { entity: 'place' as const, op: 'delete' as const, recordId: id, queuedAt };
}

beforeEach(async () => {
  await outboxRepository.clearAll();
});

afterEach(async () => {
  await outboxRepository.clearAll();
  await Dexie.delete('china-trip-planner');
});

describe('outboxRepository — coalescing', () => {
  it('collapses repeated edits of one record to a single latest entry', async () => {
    await outboxRepository.append(upsert('p1', 'First'));
    await outboxRepository.append(upsert('p1', 'Second'));
    await outboxRepository.append(upsert('p1', 'Third'));

    const entries = await outboxRepository.list();
    expect(entries).toHaveLength(1);
    expect((entries[0].payload as Place).name).toBe('Third');
    expect(await outboxRepository.count()).toBe(1);
  });

  it('collapses edit-then-delete to just the delete', async () => {
    await outboxRepository.append(upsert('p1', 'Edited'));
    await outboxRepository.append(del('p1'));

    const entries = await outboxRepository.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe('delete');
    expect(entries[0].payload).toBeUndefined();
  });

  it('collapses delete-then-recreate to just the upsert', async () => {
    await outboxRepository.append(del('p1'));
    await outboxRepository.append(upsert('p1', 'Back again'));

    const entries = await outboxRepository.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe('upsert');
  });

  it('keeps separate records separate, in queue order', async () => {
    await outboxRepository.append(upsert('p1', 'One'));
    await outboxRepository.append(upsert('p2', 'Two'));
    await outboxRepository.append(upsert('p1', 'One again'));

    const entries = await outboxRepository.list();
    expect(entries).toHaveLength(2);
    // p1 was re-queued, so it moves to the back — replay order is "most
    // recently touched last", which is also the order they were decided in.
    expect(entries.map((e) => e.recordId)).toEqual(['p2', 'p1']);
  });

  it('keeps the ORIGINAL queuedAt when a record is re-edited', async () => {
    // The staleness disclosure measures "how long have I been showing only
    // device data", so it has to date from when the record first went
    // un-uploaded — not from the most recent keystroke, which would keep
    // resetting the clock and never trip the threshold.
    await outboxRepository.append(upsert('p1', 'First', '2026-11-10T01:00:00.000Z'));
    await outboxRepository.append(upsert('p1', 'Second', '2026-11-10T09:00:00.000Z'));

    expect(await outboxRepository.oldestQueuedAt()).toBe('2026-11-10T01:00:00.000Z');
  });

  it('reports no age once drained', async () => {
    await outboxRepository.append(upsert('p1', 'One'));
    const [entry] = await outboxRepository.list();
    await outboxRepository.remove(entry.seq!);

    expect(await outboxRepository.count()).toBe(0);
    expect(await outboxRepository.oldestQueuedAt()).toBeUndefined();
  });
});
