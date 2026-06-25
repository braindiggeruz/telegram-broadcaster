# Telegram Broadcast Dashboard — TODO

## Phase 1: Schema & DB
- [x] Add broadcasts, broadcast_logs, bot_settings, recipient_lists tables to drizzle/schema.ts
- [x] Generate migration and apply SQL
- [x] Add DB helpers in server/db.ts

## Phase 2: Global Style & Layout
- [x] Configure elegant dark theme with premium color palette in index.css
- [x] Add Inter + JetBrains Mono fonts in index.html
- [x] Build sidebar DashboardLayout with all nav sections
- [x] Set up App.tsx routes for all pages

## Phase 3: Backend Routers
- [x] bot router: save/validate token, get status
- [x] recipients router: upload list (JSON/CSV parse), list, delete
- [x] broadcast router: create, launch, get progress, history, report
- [x] stats router: dashboard stats (total broadcasts, messages sent, success rate)

## Phase 4: Frontend Pages
- [x] Dashboard Home — stats cards + recent activity feed
- [x] Bot Token Management — save/validate token with status indicator
- [x] Recipient Lists — drag-and-drop upload, preview chat IDs, count
- [x] Message Composer — rich text, HTML/Markdown toggle, char counter, live preview

## Phase 5: Frontend Pages (continued)
- [x] Broadcast Configuration — delay slider (0.5–5s), parse mode, dry-run toggle
- [x] Broadcast Launch — one-click launch, real-time progress bar (sent/failed/remaining)
- [x] Broadcast History — table with date, recipients, success rate, status badge
- [x] Broadcast Report — per-message log, download JSON button

## Phase 6: Polish & Tests
- [x] Responsive layout verification
- [x] Vitest tests for routers (7/7 passing)
- [x] Final checkpoint
