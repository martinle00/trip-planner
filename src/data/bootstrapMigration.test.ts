import { describe, expect, it, vi } from 'vitest';
import { bootstrapMigration } from './bootstrapMigration';
import type { TripRepository } from './tripRepository';
import type { Trip, TripSnapshot } from './schema';

const trip: Trip = {
  id: 'trip-1',
  name: 'Test Trip',
  startDate: '2026-01-01',
  endDate: '2026-01-05',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1 },
  cities: [],
};

const snapshot: TripSnapshot = { version: 5, trip, days: [], places: [], itinerary: [], expenses: [] };

function makeRepo(overrides: Partial<TripRepository>): TripRepository {
  return {
    async seedIfEmpty() {},
    async getTrip() {
      return undefined;
    },
    async saveTrip() {},
    async listPlaces() {
      return [];
    },
    async upsertPlace(p) {
      return p;
    },
    async deletePlace() {},
    async updatePlaceIfUnchanged(place) {
      return { place, conflict: false };
    },
    async listDays() {
      return [];
    },
    async listItinerary() {
      return [];
    },
    async listAllItinerary() {
      return [];
    },
    async upsertItineraryItem(i) {
      return i;
    },
    async deleteItineraryItem() {},
    async listExpenses() {
      return [];
    },
    async upsertExpense(e) {
      return e;
    },
    async deleteExpense() {},
    async exportSnapshot() {
      return snapshot;
    },
    async importSnapshot() {},
    ...overrides,
  };
}

describe('bootstrapMigration', () => {
  it('pushes local data to remote when local exists and remote is empty', async () => {
    const local = makeRepo({ async getTrip() { return trip; } });
    const importSnapshot = vi.fn(async () => {});
    const remote = makeRepo({ async getTrip() { return undefined; }, importSnapshot });
    await bootstrapMigration(local, remote);
    expect(importSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it('does nothing when remote already has a trip, regardless of local', async () => {
    const local = makeRepo({ async getTrip() { return trip; } });
    const importSnapshot = vi.fn(async () => {});
    const remote = makeRepo({ async getTrip() { return trip; }, importSnapshot });
    await bootstrapMigration(local, remote);
    expect(importSnapshot).not.toHaveBeenCalled();
  });

  it('does nothing when both local and remote are empty', async () => {
    const local = makeRepo({ async getTrip() { return undefined; } });
    const importSnapshot = vi.fn(async () => {});
    const remote = makeRepo({ async getTrip() { return undefined; }, importSnapshot });
    await bootstrapMigration(local, remote);
    expect(importSnapshot).not.toHaveBeenCalled();
  });
});
