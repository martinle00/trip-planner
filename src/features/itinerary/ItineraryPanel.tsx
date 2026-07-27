// Itinerary tab — grouped by city, day-trip legs nested under their base
// city. Sticky quick-nav ("jump to today" + per-city jump), reorder mode
// where stops are dragged by their grip handle (toggle reads "Save changes"
// while active), add/edit/remove stops.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTripStore } from '../../store/useTripStore';
import { Icon } from '../../components/Icons';
import { Modal } from '../../components/Modal';
import { BackToTop } from '../../components/BackToTop';
import { citySlug } from '../../components/RouteStrip';
import type { ID, ItineraryItem } from '../../data/schema';
import { buildDayColorMap, buildItinerarySections, dayColor, dayLabel } from '../../lib/tripView';
import { todayISO } from '../../lib/dates';

interface StopFormValues {
  title: string;
  startTime?: string;
  durationMin?: number;
  note?: string;
}

// Mirrors the identical helper in RouteStrip.tsx/MapPanel.tsx — same
// implementation, deliberately not extracted to a shared module (matching
// the existing pattern in this codebase of a small local copy per file).
export function ItineraryPanel() {
  const trip = useTripStore((s) => s.trip);
  const days = useTripStore((s) => s.days);
  const itineraryByDay = useTripStore((s) => s.itineraryByDay);
  const addItineraryItem = useTripStore((s) => s.addItineraryItem);
  const updateItineraryItem = useTripStore((s) => s.updateItineraryItem);
  const removeItineraryItem = useTripStore((s) => s.removeItineraryItem);

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
          {reorderMode ? (
            <>
              <Icon name="check" /> Save changes
            </>
          ) : (
            <>
              <Icon name="grip" /> Reorder stops
            </>
          )}
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
                    <StopList
                      dayId={day.id}
                      items={items}
                      reorderMode={reorderMode}
                      onEdit={setEditingItem}
                      onRemove={(item) => void removeItineraryItem(item.id)}
                    />
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

      <BackToTop />

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

interface StopListProps {
  dayId: ID;
  items: ItineraryItem[];
  reorderMode: boolean;
  onEdit: (item: ItineraryItem) => void;
  onRemove: (item: ItineraryItem) => void;
}

interface DragState {
  pointerId: number;
  /** Index the drag started from, into the currently rendered order. */
  from: number;
  /** Index the stop would land on if released now. */
  to: number;
  /** Pointer travel since pointerdown, in px. */
  dy: number;
  startY: number;
  /** Height the dragged row occupies including the list gap — every row it
   *  passes shifts by exactly this much, whatever its own height is. */
  slot: number;
  rowMids: number[];
}

/**
 * The stops of one day, reorderable by dragging the grip handle while
 * reorder mode is on.
 *
 * Pointer Events (not HTML5 drag-and-drop) because this list is read and
 * edited on a phone, where dragstart never fires. Rows other than the
 * dragged one are previewed with a transform rather than by re-ordering the
 * array, so the geometry captured at pointerdown stays valid for the whole
 * gesture. `pendingOrder` holds the new order locally until the store's
 * async write lands, so the row doesn't snap back for a frame on drop.
 */
function StopList({ dayId, items, reorderMode, onEdit, onRemove }: StopListProps) {
  const reorderItinerary = useTripStore((s) => s.reorderItinerary);
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pendingOrder, setPendingOrder] = useState<ID[] | null>(null);

  const ordered = useMemo(() => {
    if (!pendingOrder) return items;
    const byId = new Map(items.map((i) => [i.id, i]));
    const next = pendingOrder.map((id) => byId.get(id)).filter((i): i is ItineraryItem => Boolean(i));
    return next.length === items.length ? next : items;
  }, [items, pendingOrder]);

  // Leaving reorder mode mid-gesture must not strand the drag transform.
  useEffect(() => {
    if (!reorderMode) setDrag(null);
  }, [reorderMode]);

  const commit = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      const ids = ordered.map((i) => i.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      setPendingOrder(ids);
      // A failed write leaves the store order untouched, so clearing the
      // pending order reverts the row — same last-write-wins behaviour the
      // rest of the app has.
      void reorderItinerary(dayId, ids)
        .finally(() => setPendingOrder(null))
        .catch(() => {});
    },
    [dayId, ordered, reorderItinerary],
  );

  function handlePointerDown(e: ReactPointerEvent<HTMLElement>, index: number) {
    if (!reorderMode || drag || e.button !== 0) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.stop') ?? []);
    if (rows.length < 2) return;
    const rects = rows.map((r) => r.getBoundingClientRect());
    const gap = rects[1].top - rects[0].bottom;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      pointerId: e.pointerId,
      from: index,
      to: index,
      dy: 0,
      startY: e.clientY,
      slot: rects[index].height + gap,
      rowMids: rects.map((r) => r.top + r.height / 2),
    });
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLElement>) {
    setDrag((d) => {
      if (!d || d.pointerId !== e.pointerId) return d;
      const dy = e.clientY - d.startY;
      const center = d.rowMids[d.from] + dy;
      let to = d.from;
      for (let i = 0; i < d.rowMids.length; i++) {
        if (i < d.from && center < d.rowMids[i]) to = Math.min(to, i);
        if (i > d.from && center > d.rowMids[i]) to = Math.max(to, i);
      }
      return { ...d, dy, to };
    });
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLElement>, cancelled = false) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!cancelled) commit(drag.from, drag.to);
    setDrag(null);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLElement>, index: number) {
    if (!reorderMode) return;
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const to = index + delta;
    if (to < 0 || to >= ordered.length) return;
    commit(index, to);
  }

  function transformFor(index: number): string | undefined {
    if (!drag) return undefined;
    if (index === drag.from) return `translateY(${drag.dy}px)`;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return `translateY(${-drag.slot}px)`;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return `translateY(${drag.slot}px)`;
    return undefined;
  }

  return (
    <div className={`stop-list${drag ? ' is-dragging' : ''}`} ref={listRef}>
      {ordered.map((item, idx) => (
        <StopRow
          key={item.id}
          item={item}
          position={idx + 1}
          total={ordered.length}
          reorderMode={reorderMode}
          isDragged={drag?.from === idx}
          transform={transformFor(idx)}
          onHandlePointerDown={(e) => handlePointerDown(e, idx)}
          onHandlePointerMove={handlePointerMove}
          onHandlePointerUp={(e) => handlePointerUp(e)}
          onHandlePointerCancel={(e) => handlePointerUp(e, true)}
          onHandleKeyDown={(e) => handleKeyDown(e, idx)}
          onEdit={() => onEdit(item)}
          onRemove={() => onRemove(item)}
        />
      ))}
    </div>
  );
}

interface StopRowProps {
  item: ItineraryItem;
  position: number;
  total: number;
  reorderMode: boolean;
  isDragged: boolean;
  transform?: string;
  onHandlePointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onHandlePointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onHandlePointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onHandlePointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onHandleKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onEdit: () => void;
  onRemove: () => void;
}

function StopRow({
  item,
  position,
  total,
  reorderMode,
  isDragged,
  transform,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
  onHandlePointerCancel,
  onHandleKeyDown,
  onEdit,
  onRemove,
}: StopRowProps) {
  return (
    <div
      className={`stop${reorderMode ? ' reorder-mode' : ''}${isDragged ? ' is-dragged' : ''}`}
      style={transform ? { transform } : undefined}
    >
      {reorderMode && (
        <button
          className="icon-btn stop-grip"
          aria-label={`Reorder ${item.title}, ${position} of ${total}. Drag, or press the up and down arrow keys.`}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerCancel}
          onKeyDown={onHandleKeyDown}
        >
          <Icon name="grip" />
        </button>
      )}
      <div className="stop-time tabular">{item.startTime ?? '--:--'}</div>
      <div className="stop-body">
        <div className="stop-title">{item.title}</div>
        {item.durationMin != null && <div className="stop-meta">{item.durationMin} min</div>}
        {item.note && <div className="stop-note">{item.note}</div>}
      </div>
      <div className="stop-actions">
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
