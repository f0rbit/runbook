# Implementation Plan

## Phase 1: Phase 0: Schema & Foundation

- **0.1**: Add `service_type` column to `booking_requests` table in schema.ts. Define a new SessionType union covering all 12 types: 'tracking' | 'production' | 'mixing' | 'mastering' | 'mentorship' | 'editing_restoration' | 'mixing_mastering' | 'hybrid_session' | 'vocal_editing' | 'creative_mixing' | 'coffee'. Add SESSION_CATEGORY grouping type ('individual' | 'combined'). Generate Drizzle migration via drizzle-kit.
  - Files: src/lib/db/schema.ts, drizzle.config.ts, migrations/
  - Parallel safe: no
- **0.2**: Change default theme from 'light' to 'dark' in entry-server.tsx (data-theme attribute). Update ThemeToggle initial state to default to dark when no localStorage value exists.
  - Files: src/entry-server.tsx, src/components/shared/ThemeToggle.tsx
  - Parallel safe: yes
- **0.3**: Write a one-time migration script to delete the '777 spammer' client and all their related data (booking_requests, conversations, messages, time_slots). This can be a SQL migration file or a script in migrations/.
  - Files: migrations/
  - Parallel safe: yes

## Phase 2: Phase 1: Booking Page Restructure — Session Types & Data

- **1.1**: Rewrite SessionTypeSelector.tsx to implement the two-tier selection system. Top level shows two buttons: 'Individual Services' (subtitle: 'Focused services when your project is already in motion') and 'Combined Solutions' (subtitle: 'Creative and technical as one'). Clicking either reveals the sub-category buttons. Individual: Tracking, Production, Mixing, Mastering, Personalised Mentorship/Workshop, Editing & Restoration. Combined: Mixing & Mastering, Hybrid Session, Vocal Editing, Creative Mixing. Both categories always show the 'Let's have a cup of tea' button. Each service button has an expandable info panel with the description text from the spec. Rename 'Recording' to 'Tracking' everywhere. Show pricing hints per service (hourly rate, flat rate, etc.) where specified.
  - Files: src/components/booking/SessionTypeSelector.tsx, src/styles/app.css
  - Parallel safe: no
- **1.2**: Define a SERVICE_CONFIG data structure (constant map) containing all 12 service types with: label, category, description text, expandable info text, pricing hint text, and custom prompt placeholder for the message textarea. This config drives SessionTypeSelector, BookingReceipt, and the booking form. Export from a new file or from SessionTypeSelector.
  - Files: src/components/booking/SessionTypeSelector.tsx
  - Parallel safe: yes
- **1.3**: Update BookingReceipt.tsx to handle all 12 session types. Update SESSION_LABELS map. Handle pricing display for different rate types (hourly, flat rate, free for tea). Rename 'Coffee & Chat' to 'Let's have a cup of tea' with updated receipt display.
  - Files: src/components/booking/BookingReceipt.tsx
  - Parallel safe: yes
- **1.4**: Update the booking page (src/routes/book/index.tsx) to: (a) use new SessionType union, (b) change the Message textarea placeholder dynamically based on selected service type using SERVICE_CONFIG prompt text, (c) send service_type in the POST body to /api/bookings, (d) implement the 'Buy me a coffee' → 'Let's have a cup of tea' rename with updated subtitle ('Let's catch up on music, life, and the rest over a nice cup of tea') and italic description text, (e) cap tea/coffee slot selection to max 1 hour (1 slot), (f) remove morning-only filter for coffee — keep morning suggestion but allow any time, or keep morning filter per spec ambiguity.
  - Files: src/routes/book/index.tsx
  - Parallel safe: no
- **1.5**: Update bookings API route and BookingsService to accept and store `service_type` field. Add service_type to the POST /api/bookings body schema (Elysia t.Object). Pass through to BookingsService.create(). Store in booking_requests table. Include in admin notification email template.
  - Files: src/lib/api/routes/bookings.ts, src/lib/services/bookings.ts, src/lib/email/index.ts
  - Parallel safe: no

## Phase 3: Phase 2: Booking Page UX — Wizard Flow

- **2.1**: Refactor the booking page into a stepped wizard/full-screen-section flow. Each section ('What do you need?', service info + prompt, 'Pick a time', 'Your details', Receipt) occupies the full viewport height. Animate transitions between sections (smooth scroll or CSS transition). The wizard auto-advances when a selection is made (e.g., picking a service type scrolls to the prompt/calendar section). This serves as the loading buffer the spec mentions — the calendar loads in the background while the user reads service info.
  - Files: src/routes/book/index.tsx, src/styles/app.css
  - Parallel safe: no

## Phase 4: Phase 3: Landing Page Changes

- **3.1**: Update the landing page (src/routes/index.tsx): (a) Remove the '---Producer---' subtitle (the <p class='landing-subtitle'>Producer</p> and its CSS ::before/::after dashes). (b) Implement animated font cycling on Byron's name — a slow Loki-style effect where the font-family cycles through several decorative fonts with smooth transitions. Use CSS @keyframes or a SolidJS createEffect with setInterval for the font rotation. Make it slower than typical implementations. (c) Tighten letter-spacing on the name (reduce from current 0.3em).
  - Files: src/routes/index.tsx, src/styles/app.css
  - Parallel safe: no

## Phase 5: Phase 4: Site Header & New Pages

- **4.1**: Redesign the shared Header component to include navigation links for the new pages: Home, About Me, Equipment, My Work, Book a Session, and a placeholder 'Mycelia' link. The header should be site-wide (included in Layout.tsx), visually consistent with the existing admin header pattern but for the public site. Add the ThemeToggle into the header instead of floating. Update Layout.tsx to include the Header and optionally the Footer.
  - Files: src/components/shared/Header.tsx, src/components/shared/Layout.tsx, src/components/shared/index.ts, src/styles/app.css
  - Parallel safe: no
- **4.2**: Create the About Me page at src/routes/about.tsx. Include a photo placeholder (empty image container with alt text), and placeholder bio text based on spec hints (music history, Bachelor of Sonic Arts at University of Adelaide, self-taught passion, segue link to Mycelia). Mark content sections as TBD for Byron to fill in later. Use Layout with Header/Footer.
  - Files: src/routes/about.tsx, src/styles/app.css
  - Parallel safe: yes
- **4.3**: Create the Equipment page at src/routes/equipment.tsx. Render the full categorized gear list from the spec: Studio Hardware (Interfaces, Monitoring, Computer, Outboard), Microphones (Dynamics, Condensers, Specialty), Instruments (Guitars, Modified upright pianola), Synthesis & Hardware Effects (Synths, Samplers & Drum Machines, Pedals, Controllers), In the Box — Software & Plugins (with italic disclaimer, DAW Primary/Secondary, Editing & Restoration, Mixing Suite, Virtual Instruments). Use collapsible sections or a clean categorized list layout.
  - Files: src/routes/equipment.tsx, src/styles/app.css
  - Parallel safe: yes
- **4.4**: Create the My Work / Portfolio page at src/routes/work.tsx. Placeholder page with a 'Coming Soon' or 'Portfolio items will be added soon' message. Structure it to eventually show a reverse-chronological list of works with album art / screenshots. Mark as TBD for content from Byron.
  - Files: src/routes/work.tsx, src/styles/app.css
  - Parallel safe: yes
- **4.5**: Create the Mycelia page at src/routes/mycelia.tsx. Simple 'Coming Soon' placeholder page with the Mycelia branding/name. Minimal content, just signals that something is in development.
  - Files: src/routes/mycelia.tsx, src/styles/app.css
  - Parallel safe: yes
- **4.6**: Update the landing page (src/routes/index.tsx) to include the new Header (via Layout wrapper or direct import). Ensure the landing page still has the full-viewport centered design but now with the header visible at the top.
  - Files: src/routes/index.tsx
  - Parallel safe: no

## Phase 6: Phase 5: Admin Client Management

- **5.1**: Add 6-month inactivity detection to the admin clients list page. For each client, compute months since last booking. If > 6 months, show a visual indicator (badge/icon) next to their name prompting the admin to consider archiving. Add a button or link that triggers the existing archive flow. This is UI-only — the archive functionality already exists in ClientsService.
  - Files: src/routes/admin/clients/index.tsx, src/styles/app.css
  - Parallel safe: yes
- **5.2**: Improve the archived clients section in the admin clients UI. Currently the list page only shows non-archived clients. Add a toggle or tab to view archived clients (using ClientsService.listArchived()). Show archived clients in a visually distinct way (grayed out, with restore buttons). Improve the overall archive/restore UX.
  - Files: src/routes/admin/clients/index.tsx, src/styles/app.css
  - Parallel safe: yes

## Phase 7: Phase 6: Override Overlap Bug Fix

- **6.1**: Fix the all-day block override stacking bug. In OverridesService.create(), add overlap validation: before inserting a new override, query existing overrides on the same date. If the new override is an all-day block (00:00-23:59) and an all-day block already exists for that date, return a validation error. More generally, check for time range overlaps between same-type overrides on the same date. This prevents duplicate all-day blocks while still allowing partial-day overrides that don't overlap.
  - Files: src/lib/services/overrides.ts
  - Parallel safe: no
- **6.2**: Add client-side validation in OverrideModal.tsx to warn the user before submitting if an all-day block already exists for the selected date. This requires fetching existing overrides for the selected date (the parent component likely already has this data from the overrides list). Show an inline error message.
  - Files: src/components/admin/OverrideModal.tsx, src/routes/admin/schedule/overrides.tsx
  - Parallel safe: no

## Breaking Changes

- BREAKING: SessionType union type changes from 'recording'|'production'|'mixing'|'coffee' to 12 new values. All components importing SessionType will need updating. 'recording' is renamed to 'tracking'. Any external consumers of this type will break.
- BREAKING: booking_requests schema gains a new `service_type` column. Existing rows will have NULL for this field. Migration required on Cloudflare D1.
- BREAKING: POST /api/bookings body schema adds optional `service_type` field. Backwards compatible (optional), but older form submissions won't include it.
- BREAKING: Default theme changes from light to dark. Users with no localStorage preference will now see dark mode on first visit instead of light mode. Existing users with a saved preference are unaffected.
- BREAKING: The '777 spammer' client deletion is destructive and irreversible. All their bookings, conversations, and messages will be permanently removed.
