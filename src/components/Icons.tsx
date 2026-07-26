// SVG icon sprite lifted from the mockup's <symbol> defs, plus a small <Icon>
// wrapper. IconSprite is mounted once near the app root; Icon renders a
// <use> reference to it (same technique the mockup uses).

export function IconSprite() {
  return (
    <svg className="visually-hidden" aria-hidden="true" focusable="false">
      <defs>
        <symbol id="i-sparkle" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
          <path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" />
        </symbol>
        <symbol id="i-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 21s-7-6.2-7-11.5A7 7 0 0112 2a7 7 0 017 7.5C19 14.8 12 21 12 21z" />
          <circle cx="12" cy="9.5" r="2.3" />
        </symbol>
        <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </symbol>
        <symbol id="i-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
        </symbol>
        <symbol id="i-grip" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="8" cy="6" r="1.5" /><circle cx="8" cy="12" r="1.5" /><circle cx="8" cy="18" r="1.5" />
          <circle cx="16" cy="6" r="1.5" /><circle cx="16" cy="12" r="1.5" /><circle cx="16" cy="18" r="1.5" />
        </symbol>
        <symbol id="i-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
        </symbol>
        <symbol id="i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </symbol>
        <symbol id="i-map" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" />
        </symbol>
        <symbol id="i-list" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </symbol>
        <symbol id="i-calendar" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />
        </symbol>
        <symbol id="i-wallet" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><circle cx="16" cy="14" r="1.2" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12l5 5L19 7" />
        </symbol>
        <symbol id="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
        </symbol>
        <symbol id="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 14.2A8.5 8.5 0 1110 3.3 6.7 6.7 0 0020 14.2z" />
        </symbol>
        <symbol id="i-target" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </symbol>
        <symbol id="i-minus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M5 12h14" />
        </symbol>
        <symbol id="i-arrow-up" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5M6 11l6-6 6 6" />
        </symbol>
        <symbol id="i-arrow-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M6 13l6 6 6-6" />
        </symbol>
        <symbol id="i-cat-landmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l4 6h-8l4-6z" /><path d="M6 22V10M18 22V10M2 22h20" />
        </symbol>
        <symbol id="i-cat-garden" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22V12" /><path d="M12 12C12 12 5 11 5 4c7 0 7 7 7 8z" /><path d="M12 15C12 15 19 14 19 7c-7 0-7 7-7 8z" />
        </symbol>
        <symbol id="i-cat-museum" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-6 9 6" /><path d="M4 9h16v11H4z" /><path d="M9 20v-7M15 20v-7" />
        </symbol>
        <symbol id="i-cat-market" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 8l1.5-4h13L20 8" /><path d="M4 8h16l-1 12H5L4 8z" /><path d="M9 12a3 3 0 006 0" />
        </symbol>
        <symbol id="i-cat-nature" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l5 8h-3l4 6H6l4-6H7l5-8z" /><path d="M12 21v-4" />
        </symbol>
        <symbol id="i-cat-food" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 2v8a2 2 0 002 2v10M6 2v10M9 2v10" /><path d="M17 2c-1.5 0-3 1.5-3 5s1 5 1 5v10" />
        </symbol>
        <symbol id="i-cat-shopping" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 3h7a1 1 0 011 1v7a1 1 0 01-.3.7l-9 9a1 1 0 01-1.4 0l-7-7a1 1 0 010-1.4l9-9A1 1 0 0111 3z" />
          <circle cx="15.5" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
        </symbol>
        <symbol id="i-cat-entertainment" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 8a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 100 4v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2a2 2 0 100-4V8z" />
          <path d="M12 6v3M12 15v3" />
        </symbol>
        <symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
        </symbol>
        <symbol id="i-chevron-left" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </symbol>
        <symbol id="i-chevron-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </symbol>
        <symbol id="i-book" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5v-15z" /><path d="M4 20.5A2.5 2.5 0 006.5 18H20" />
        </symbol>
        <symbol id="i-quote" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 8c-2 1-3 3-3 5.5S6 18 8 18" /><path d="M17 8c-2 1-3 3-3 5.5S20 18 22 18" />
        </symbol>
        <symbol id="i-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 11A8.1 8.1 0 006.3 6.3L4 8.6" /><path d="M4 4v4.6h4.6" />
          <path d="M4 13a8.1 8.1 0 0013.7 4.7L20 15.4" /><path d="M20 20v-4.6h-4.6" />
        </symbol>
        <symbol id="i-alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3.3l9.7 17.4H2.3L12 3.3z" /><path d="M12 10v4.2" /><circle cx="12" cy="17.4" r="0.6" fill="currentColor" stroke="none" />
        </symbol>
        {/* Header/nav condensing refinement (mockup/header-nav-hierarchy.html
            #v3-condense) — Export/Import/Sign out collapse to icon-only in
            the desktop condensed state, which needs an icon for each where
            production previously only had text. */}
        <symbol id="i-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 19h16" />
        </symbol>
        <symbol id="i-upload" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 15V3M7 8l5-5 5 5" /><path d="M4 19h16" />
        </symbol>
        <symbol id="i-logout" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" />
        </symbol>
        {/* Phase 5 — Budget tab: "Paid by" when an expense's payer no longer
            resolves to a trip member (orphaned id, see Expense.paidBy's doc
            comment in data/schema.ts). */}
        <symbol id="i-user" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="3.4" /><path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5" />
        </symbol>
      </defs>
    </svg>
  );
}

export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}
