// Itinerary tab — grouped by city, day-trip legs nested under their base
// city. Sticky quick-nav ("jump to today" + per-city jump), reorder mode
// with up/down move buttons (ends disabled), add/edit/remove stops.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTripStore } from '../../store/useTripStore';
import { Icon } from '../../components/Icons';
import { Modal } from '../../components/Modal';
import { citySlug } from '../../components/RouteStrip';
import type { ItineraryItem } from '../../data/schema';
import { buildDayColorMap, buildItinerarySections, dayColor, dayLabel } from '../../lib/tripView';
import { todayISO } from '../../lib/dates';

interface StopFormValues {
  title: string;
  startTime?: string;
  durationMin?: number;
  note?: string;
}

export function ItineraryPanel() {
  const trip = useTripStore((s) => s.trip);
  const days = useTripStore((s) => s.days);
  const itineraryByDay = useTripStore((s) => s.itineraryByDay);
  const addItineraryItem = useTripStore((s) => s.addItineraryItem);
  const updateItineraryItem = useTripStore((s) => s.updateItineraryItem);
  const removeItineraryItem = useTripStore((s) => s.removeItineraryItem);
  const reorderItinerary = useTripStore((s) => s.reorderItinerary);

  const [reorderMode, setReorderMode] = useState(false);
  const [flashDayId, setFlashDayId] = useState<string | null>(null);
  const [addingToDay, setAddingToDay] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<ItineraryItem | null>(null);

  const dayColorMap = useMemo(() => buildDayColorMap(days), [days]);
  const sections = useMemo(() => (trip ? buildItinerarySections(trip, days) : []), [trip, days]);

  const jumpToToday = useCallback(() => {
    if (days.length === 0) return;
    const today = todayISO();
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const target = sorted.find((d) => d.date === today) ?? sorted.find((d) => d.date > today) ?? sorted[sorted.length - 1];
    const el = document.getElementById(`it-day-${target.id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setFlashDayId(target.id);
    window.setTimeout(() => setFlashDayId(null), 1800);
  }, [days]);

  const scrollToCity = useCallback((name: string) => {
    document.getElementById(`it-${citySlug(name)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (!trip) return null;

  return (
    <section
      className={`panel${reorderMode ? ' reorder-mode' : ''}`}
      id="panel-itinerary"
      role="tabpanel"
      aria-labelledby="tab-itinerary"
    >
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Itinerary</h2>
          <span className="panel-hint">Grouped by city &middot; read this on your phone</span>
        </div>
        <button
          className={`btn btn-sm${reorderMode ? ' btn-primary' : ' btn-ghost'}`}
          aria-pressed={reorderMode}
          onClick={() => setReorderMode((v) => !v)}
        >
          <Icon name="grip" /> Reorder stops
        </button>
      </div>

      <div className="it-quicknav" id="itQuickNav">
        <button className="it-nav-today" onClick={jumpToToday}>
          <Icon name="target" /> Jump to today
        </button>
        <div className="it-nav-cities">
          {sections.map((s) => (
            <button key={s.city.name} onClick={() => scrollToCity(s.city.name)}>
              {s.city.name}
            </button>
          ))}
        </div>
      </div>

      {sections.map((section) => (
        <div className="it-city" id={`it-${citySlug(section.city.name)}`} key={section.city.name}>
          <div className="it-city-head">
            <h3>{section.city.name}</h3>
            <span className="range">{section.range}</span>
          </div>

          {section.days.length === 0 ? (
            <div className="it-condensed">
              <span className="it-condensed-text">No days scheduled for this leg yet.</span>
            </div>
          ) : (
            section.days.map(({ day, nested }) => {
              const items = itineraryByDay[day.id] ?? [];
              const color = dayColor(day.id, dayColorMap);
              return (
                <div
                  key={day.id}
                  id={`it-day-${day.id}`}
                  className={`it-day${nested ? ' nested' : ''}${flashDayId === day.id ? ' today-flash' : ''}`}
                >
                  <div className="it-day-head">
                    <span className="it-day-dot" style={{ background: color }} />
                    <span className="it-day-title">{dayLabel(day, nested ? [] : section.ownDays)}</span>
                  </div>

                  {items.length === 0 ? (
                    <div className="it-condensed">
                      <span className="it-condensed-text">No stops planned yet.</span>
                    </div>
                  ) : (
                    <div className="stop-list">
                      {items.map((item, idx) => (
                        <StopRow
                          key={item.id}
                          item={item}
                          reorderMode={reorderMode}
                          isFirst={idx === 0}
                          isLast={idx === items.length - 1}
                          onMoveUp={() => {
                            if (idx === 0) return;
                            const ids = items.map((i) => i.id);
                            [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
                            void reorderItinerary(day.id, ids);
                          }}
                          onMoveDown={() => {
                            if (idx === items.length - 1) return;
                            const ids = items.map((i) => i.id);
                            [ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]];
                            void reorderItinerary(day.id, ids);
                          }}
                          onEdit={() => setEditingItem(item)}
                          onRemove={() => void removeItineraryItem(item.id)}
                        />
                      ))}
                    </div>
                  )}

                  <button className="add-stop-row" onClick={() => setAddingToDay(day.id)}>
                    <Icon name="plus" /> Add stop
                  </button>
                </div>
              );
            })
          )}
        </div>
      ))}

      <StopFormModal
        open={addingToDay !== null || editingItem !== null}
        dayId={addingToDay ?? editingItem?.dayId ?? null}
        item={editingItem}
        onClose={() => {
          setAddingToDay(null);
          setEditingItem(null);
        }}
        onSubmit={async (values) => {
          if (editingItem) {
            await updateItineraryItem({ ...editingItem, ...values });
          } else if (addingToDay) {
            await addItineraryItem({ dayId: addingToDay, ...values });
          }
          setAddingToDay(null);
          setEditingItem(null);
        }}
      />
    </section>
  );
}

interface StopRowProps {
  item: ItineraryItem;
  reorderMode: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function StopRow({ item, reorderMode, isFirst, isLast, onMoveUp, onMoveDown, onEdit, onRemove }: StopRowProps) {
  return (
    <div className={`stop${reorderMode ? ' reorder-mode' : ''}`}>
      <div className="stop-time tabular">{item.startTime ?? '--:--'}</div>
      <div className="stop-body">
        <div className="stop-title">{item.title}</div>
        {item.durationMin != null && <div className="stop-meta">{item.durationMin} min</div>}
        {item.note && <div className="stop-note">{item.note}</div>}
      </div>
      <div className="stop-actions">
        <button className="icon-btn stop-move" aria-label="Move stop up" disabled={isFirst} onClick={onMoveUp}>
          <Icon name="arrow-up" />
        </button>
        <button className="icon-btn stop-move" aria-label="Move stop down" disabled={isLast} onClick={onMoveDown}>
          <Icon name="arrow-down" />
        </button>
        <button className="icon-btn" aria-label={`Edit ${item.title}`} onClick={onEdit}>
          <Icon name="edit" />
        </button>
        <button className="icon-btn" aria-label={`Remove ${item.title}`} onClick={onRemove}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

interface StopFormModalProps {
  open: boolean;
  dayId: string | null;
  item: ItineraryItem | null;
  onClose: () => void;
  onSubmit: (values: StopFormValues) => void;
}

function StopFormModal({ open, dayId, item, onClose, onSubmit }: StopFormModalProps) {
  const [title, setTitle] = useState('');
  const [startTime, setStartTime] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? '');
    setStartTime(item?.startTime ?? '');
    setDurationMin(item?.durationMin != null ? String(item.durationMin) : '');
    setNote(item?.note ?? '');
  }, [open, item]);

  if (!dayId) return null;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      startTime: startTime || undefined,
      durationMin: durationMin ? Number(durationMin) : undefined,
      note: note.trim() || undefined,
    });
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="stopFormTitle">
      <div className="modal-head">
        <h2 className="modal-title" id="stopFormTitle">
          {item ? 'Edit stop' : 'Add stop'}
        </h2>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="add-form-grid">
          <div className="full">
            <label htmlFor="s-title">Title</label>
            <input
              className="text-input"
              style={{ width: '100%' }}
              id="s-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="s-time">Start time</label>
            <input
              className="time-input"
              style={{ width: '100%' }}
              type="time"
              id="s-time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="s-dur">Duration (min)</label>
            <input
              className="num-input"
              style={{ width: '100%' }}
              type="number"
              min="0"
              id="s-dur"
              value={durationMin}
              onChange={(e) => setDurationMin(e.target.value)}
            />
          </div>
          <div className="full">
            <label htmlFor="s-note">Note</label>
            <input
              className="text-input"
              style={{ width: '100%' }}
              id="s-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary btn-sm">
            {item ? 'Save' : 'Add stop'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
