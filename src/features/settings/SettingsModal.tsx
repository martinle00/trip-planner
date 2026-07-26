// Settings — Phase 6 item 6. A modal opened from the topbar gear, NOT a
// fifth tab: the mobile bottom dock carries exactly four tabs by approved
// design (mockup/header-nav-hierarchy.html Variant 3), and a fifth breaks
// it.
//
// This surface exists because it earns its keep from more than one thing.
// PHASE5 deliberately put trip companions on the Budget tab ("who-paid is a
// budget concern"); PHASE6 reverses that, because collecting companions,
// home currency, theme, Export/Import and Sign out here ALSO:
//   - relieves the mobile topbar crowding Phase 5 item 1 only half-solved
//     by collapsing those buttons to icons, and
//   - removes the companions CRUD card that used to sit wedged between the
//     Budget tab's two read-only breakdown cards, which is half of what
//     made the By-person card read as off-pattern (item 7).
//
// Rendered through the shared <Modal>, which already supplies Escape,
// focus-trap and focus-restore — the design review was explicit that this
// must not be a hand-rolled overlay.

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { MemberAvatar } from '../../components/MemberAvatar';
import { Icon } from '../../components/Icons';
import { useTripStore } from '../../store/useTripStore';
import type { TripMember } from '../../data/schema';
import { MEMBER_COLOURS } from '../../lib/tripView';
import { CURRENCIES } from '../../lib/exchangeRates';
import type { Theme } from '../../lib/theme';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  onExport: () => void;
  onImportClick: () => void;
  onSignOut: () => void;
}

export function SettingsModal({
  open,
  onClose,
  theme,
  onSetTheme,
  onExport,
  onImportClick,
  onSignOut,
}: SettingsModalProps) {
  const trip = useTripStore((s) => s.trip);
  const setHomeCurrency = useTripStore((s) => s.setHomeCurrency);
  const addMember = useTripStore((s) => s.addMember);
  const renameMember = useTripStore((s) => s.renameMember);
  const removeMember = useTripStore((s) => s.removeMember);
  const setMemberColor = useTripStore((s) => s.setMemberColor);

  const [newMemberName, setNewMemberName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** Which member's colour picker is open, if any. */
  const [pickingColourFor, setPickingColourFor] = useState<string | null>(null);

  // Guards against a double-commit when Enter and the resulting blur (from
  // the input unmounting once renamingId flips back to null) both fire for
  // the same rename.
  const renameCommittingRef = useRef(false);
  // Guards a DIFFERENT race, caught in Phase 5 code review: Escape's handler
  // also unmounts the rename <input> (by flipping `renamingId` to null), and
  // removing a FOCUSED element makes real browsers synchronously fire
  // blur/focusout on it — which React delivers as this same input's `onBlur`.
  // Without this flag, Escape (meant to discard) would still call
  // commitRename and silently persist whatever half-typed value was there.
  // jsdom does not reproduce blur-on-unmount, so no test using it can catch a
  // regression here by accident — see the dedicated Escape test.
  const renameCancelingRef = useRef(false);

  if (!trip) return null;
  const members = trip.members ?? [];

  async function handleAddMember(e: FormEvent) {
    e.preventDefault();
    const trimmed = newMemberName.trim();
    if (!trimmed) return;
    await addMember(trimmed);
    setNewMemberName('');
  }

  function startRename(member: TripMember) {
    renameCancelingRef.current = false;
    setRenamingId(member.id);
    setRenameValue(member.name);
  }

  function cancelRename() {
    renameCancelingRef.current = true;
    setRenamingId(null);
  }

  async function commitRename(id: string) {
    if (renameCommittingRef.current || renameCancelingRef.current) return;
    renameCommittingRef.current = true;
    const trimmed = renameValue.trim();
    setRenamingId(null);
    try {
      if (trimmed) await renameMember(id, trimmed);
    } finally {
      renameCommittingRef.current = false;
    }
  }

  /** Picking a swatch closes the picker, which destroys the button that was
   *  just activated — so focus has to be sent somewhere deliberately. It
   *  goes back to the picker's own trigger, the standard disclosure-widget
   *  contract (closing a popover returns focus to whatever opened it).
   *  React's reconciler may well preserve focus here on its own, but this
   *  project has now shipped two focus-teardown bugs (Phase 5's
   *  rename/Escape-blur defect, AuthGate's re-gating bug) precisely because
   *  the answer was left implicit. It is explicit now. */
  function pickColour(member: TripMember, colour: string | undefined) {
    setPickingColourFor(null);
    // Restored IMMEDIATELY, deliberately NOT awaiting the write. The trigger
    // is already in the DOM (it renders whenever the member isn't being
    // renamed) and doesn't depend on the write at all, so awaiting bought
    // nothing and cost two real defects: a slow write let focus get yanked
    // back here long after the user had moved on to another member, and a
    // REJECTED write (writes require the network in this app and fail loudly
    // — see CLAUDE.md's write-through model) skipped the restore entirely,
    // leaving focus on nothing with the picker already closed. The timeout
    // only defers past React's re-render, nothing else.
    window.setTimeout(() => {
      document.getElementById(`colour-trigger-${member.id}`)?.focus();
    }, 0);
    void setMemberColor(member.id, colour);
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="settingsTitle">
      <div className="modal-head">
        <h3 id="settingsTitle">Settings</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings">
          <Icon name="close" />
        </button>
      </div>

      {/* --- Trip companions (moved here from the Budget tab) --- */}
      <section className="settings-section">
        <h4 className="settings-section-title">Trip companions</h4>
        <p className="panel-hint">
          Who&rsquo;s splitting costs on this trip &mdash; pick one as &ldquo;Paid by&rdquo; on any expense.
        </p>

        {members.length === 0 ? (
          <div className="members-empty">
            <Icon name="user" />
            <div>
              <strong>No companions yet</strong>
              <span> Add yourself and anyone else you&rsquo;re splitting costs with.</span>
            </div>
          </div>
        ) : (
          <div className="members-list">
            {members.map((m) => (
              <div className="member-row" key={m.id}>
                <span className="member-chip">
                  {renamingId === m.id ? (
                    <input
                      type="text"
                      className="rename-input"
                      value={renameValue}
                      autoFocus
                      aria-label="Rename companion"
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void commitRename(m.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitRename(m.id);
                        } else if (e.key === 'Escape') {
                          cancelRename();
                        }
                      }}
                    />
                  ) : (
                    <>
                      <MemberAvatar name={m.name} color={m.color} />
                      <span className="member-name">{m.name}</span>
                      <button
                        type="button"
                        className="icon-btn"
                        id={`colour-trigger-${m.id}`}
                        aria-label={`Choose colour for ${m.name}`}
                        aria-expanded={pickingColourFor === m.id}
                        onClick={() => setPickingColourFor(pickingColourFor === m.id ? null : m.id)}
                      >
                        <Icon name="palette" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Rename ${m.name}`}
                        onClick={() => startRename(m)}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn is-danger"
                        aria-label={`Remove ${m.name}`}
                        onClick={() => void removeMember(m.id)}
                      >
                        <Icon name="trash" />
                      </button>
                    </>
                  )}
                </span>

                {pickingColourFor === m.id && (
                  // `aria-checked` is computed from the SAME value that
                  // drives the visible selected ring, so the two cannot
                  // disagree — the design review caught a first pass that
                  // had the visual state only, which leaves a screen-reader
                  // user unable to tell which swatch is active.
                  <div className="colour-picker" role="radiogroup" aria-label={`Colour for ${m.name}`}>
                    {MEMBER_COLOURS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="radio"
                        aria-checked={m.color === c.id}
                        aria-label={c.label}
                        title={c.label}
                        className={`colour-swatch${m.color === c.id ? ' is-selected' : ''}`}
                        style={{ background: `var(--${c.id})` }}
                        onClick={() => pickColour(m, c.id)}
                      />
                    ))}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!m.color}
                      aria-label="No colour"
                      title="No colour"
                      className={`colour-swatch is-none${!m.color ? ' is-selected' : ''}`}
                      onClick={() => pickColour(m, undefined)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <form className="add-member-form" onSubmit={(e) => void handleAddMember(e)}>
          <label className="visually-hidden" htmlFor="new-member-name">
            New companion name
          </label>
          <input
            type="text"
            id="new-member-name"
            className="text-input"
            placeholder="Companion name, e.g. Priya"
            value={newMemberName}
            onChange={(e) => setNewMemberName(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            <Icon name="plus" /> Add
          </button>
        </form>
      </section>

      {/* --- Home currency (moved here from the Budget rates card) --- */}
      <section className="settings-section">
        <h4 className="settings-section-title">Home currency</h4>
        <p className="panel-hint">Every total on the Budget tab converts to this.</p>
        <select
          aria-label="Home currency — all totals convert to this"
          value={trip.homeCurrency}
          onChange={(e) => void setHomeCurrency(e.target.value)}
        >
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} &middot; {c.name}
            </option>
          ))}
        </select>
      </section>

      {/* --- Appearance --- */}
      <section className="settings-section">
        <h4 className="settings-section-title">Appearance</h4>
        <div className="theme-toggle" role="radiogroup" aria-label="Theme">
          {(['light', 'dark'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={theme === t}
              className={`btn btn-sm${theme === t ? ' btn-primary' : ' btn-ghost'}`}
              onClick={() => onSetTheme(t)}
            >
              <Icon name={t === 'dark' ? 'moon' : 'sun'} /> {t === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </section>

      {/* --- Trip data --- */}
      <section className="settings-section">
        <h4 className="settings-section-title">Trip data</h4>
        <div className="settings-actions">
          <button className="btn btn-ghost btn-sm" onClick={onExport}>
            <Icon name="download" /> Export trip.json
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onImportClick}>
            <Icon name="upload" /> Import trip.json
          </button>
        </div>
      </section>

      {/* --- Account --- */}
      <section className="settings-section">
        <h4 className="settings-section-title">Account</h4>
        <button className="btn btn-ghost btn-sm" onClick={onSignOut}>
          <Icon name="logout" /> Sign out
        </button>
      </section>
    </Modal>
  );
}
