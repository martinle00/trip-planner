// Builds Leaflet divIcons for map pins, reusing the .pin-marker / .pin-badge
// classes lifted from the mockup (see index.css) instead of Leaflet's default
// marker image. Kept framework-light: plain HTML strings, no React rendering
// inside the icon (Leaflet manages that DOM itself).

import L from 'leaflet';
import { categoryIcon } from '../../lib/tripView';

export interface PinIconOptions {
  color: string;
  category?: string;
  unassigned: boolean;
  badgeText?: string;
  selected?: boolean;
  emph?: boolean;
  dim?: boolean;
  /** True when this place has an unsaved (staged, not yet committed) day
   *  reassignment — draws a gold ring via `.pin-marker.pending` plus a small
   *  gold dot, the map's "unsaved change" signal (see the Map save-changes
   *  spec, mockup/map-save-changes.html, and its legend entry). */
  pending?: boolean;
  /** Transient "this is the one you asked for" cue, set for a couple of
   *  seconds after a search pick or a "View on map" handoff. Drawn as an
   *  expanding `::after` ring, NOT as an outline or box-shadow: those two
   *  properties are already spoken for by selected/emph and pending
   *  respectively, and a flashed pin is routinely all three at once. */
  flash?: boolean;
}

export function buildPinIcon(opts: PinIconOptions): L.DivIcon {
  const classes = ['pin-marker'];
  if (opts.unassigned) classes.push('unassigned');
  if (opts.selected) classes.push('selected');
  if (opts.emph) classes.push('emph');
  if (opts.dim) classes.push('dim');
  if (opts.pending) classes.push('pending');
  if (opts.flash) classes.push('flash');

  const iconName = categoryIcon(opts.category);
  const badge = !opts.unassigned && opts.badgeText
    ? `<span class="pin-badge" aria-hidden="true">${opts.badgeText}</span>`
    : '';
  const pendingDot = opts.pending ? '<span class="pin-pending-dot" aria-hidden="true"></span>' : '';
  const html =
    `<span class="${classes.join(' ')}" style="--pin-color:${opts.color}">` +
    `<svg aria-hidden="true"><use href="#i-${iconName}"></use></svg>${badge}${pendingDot}</span>`;

  return L.divIcon({
    html,
    className: 'pin-marker-wrap',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}
