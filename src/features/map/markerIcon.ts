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
}

export function buildPinIcon(opts: PinIconOptions): L.DivIcon {
  const classes = ['pin-marker'];
  if (opts.unassigned) classes.push('unassigned');
  if (opts.selected) classes.push('selected');
  if (opts.emph) classes.push('emph');
  if (opts.dim) classes.push('dim');

  const iconName = categoryIcon(opts.category);
  const badge = !opts.unassigned && opts.badgeText
    ? `<span class="pin-badge" aria-hidden="true">${opts.badgeText}</span>`
    : '';
  const html =
    `<span class="${classes.join(' ')}" style="--pin-color:${opts.color}">` +
    `<svg aria-hidden="true"><use href="#i-${iconName}"></use></svg>${badge}</span>`;

  return L.divIcon({
    html,
    className: 'pin-marker-wrap',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}
