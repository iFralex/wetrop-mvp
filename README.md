# Wetrop

Single-company administrative agent demo, adapted from Steward. The browser is the accountant workspace; a dedicated Telegram bot is the company’s channel. There is one application and no personal Steward mode.

## Data boundary

Everything stays inside this checkout:

- `company/`: original and generated documents, templates, source-backed wiki and graph, SQLite databases, audit, queues, indexes and conversion temporary files.
- `.runtime/`: private configuration, web access key, local dependency cache, test fixtures and reset archives.
- `node_modules/` and `apps/web/dist/`: installed dependencies and built UI.

There is no automatic reading, migration or fallback to `~/Library/Application Support/Steward`, Apple Mail, Apple Calendar, personal wiki projects or personal model credentials. The original Steward checkout is not used at runtime. Internal workspace package names retain `@steward/` for reuse; they do not select a second product.

Tool servers run in a separate read-only Docker container with no network, no Docker socket and only `company/` mounted writable. The trusted broker holds Telegram/model credentials and runs on the Mac. Missing Docker tools cause agent jobs to fail visibly; there is no unrestricted native-tool fallback. This is a demo for a trusted local network, not an Internet-ready hosted service. Use HTTPS termination before exposing the access key beyond a trusted local network.

## Bundled demo data

The repository includes [synthetic company documents and SQLite databases](demo/README.md) under `demo/aurora/`. To start with the populated example practices, run `npm run wetrop:demo:restore` after installing dependencies and before starting Wetrop. It verifies checksums and refuses to overwrite existing company data. Your runtime copy stays in ignored `company/`.

## Setup

Requirements: Node 24, npm and Docker Desktop running. AI can use a dedicated ChatGPT sign-in or an OpenAI-compatible endpoint supporting tool calls. A dedicated Telegram bot is needed only for real Telegram transport.

```sh
git clone https://github.com/iFralex/wetrop-mvp.git
cd wetrop-mvp
npm ci --ignore-scripts --cache .runtime/npm-cache
npm run wetrop:seed
mkdir -p .runtime
cp apps/wetrop/config.env.example .runtime/config.env
chmod 600 .runtime/config.env
```

For ChatGPT, run `npm run wetrop:login` on the Mac hosting Wetrop and complete **Continue with ChatGPT** in its browser. The CLI selects an available model; **Company** also supports sign-in, model selection, account selection and logout. Registration, tokens and refresh state remain private in `.runtime/chatgpt/`, outside the tool container. This uses the [official ChatGPT token-sharing OAuth flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and public Responses endpoint, without copying Codex or Steward credentials. The model catalog depends on the signed-in account. Browser sign-in currently uses a loopback callback on the hosting Mac.

Alternatively, set `WETROP_MODEL_URL`, `WETROP_MODEL`, and `WETROP_MODEL_KEY` in `.runtime/config.env`. Set `WETROP_TELEGRAM_TOKEN` when a dedicated bot is available. No secrets are checked in. The host reads only explicit Wetrop configuration and never discovers credentials from Steward.

```sh
npm run wetrop:tools
npm run wetrop:build
npm start
```

Open `http://localhost:4417`. Read the workspace key from `.runtime/access-token` and paste it into the login screen. On a second computer on the same trusted network, use `http://<Mac-mini-IP>:4417` and the same key. This is one accountant access, not multiple product modes. The key stays in browser session storage.

The tools run in the official Node 24 Linux image. `wetrop:tools` prepares an architecture-matched Linux canvas binding and offline Italian/English Tesseract WASM models inside this checkout, then starts the container. It requires network only during preparation/image download; tools have no network. Rerun it after `npm ci` to restore the Linux optional binding. PDF rasterization uses PDF.js/canvas. The minimal image does not include LibreOffice; its Office preview is a normalized content PDF, with an explicit layout warning.

SQLite connections run on the trusted host through a company-local file bridge. Linux tool processes never open SQLite files directly: this avoids cross-kernel WAL/locking corruption on Docker Desktop bind mounts. The bridge still stores every company database and request/reply under `company/.wetrop/`.

The default container UID/GID is 501:20; override `WETROP_UID`/`WETROP_GID` if the mounted files are owned by a different account. The company folder must remain this checkout’s `company/` for the supplied compose configuration.

## Telegram

In **Company**, generate a pairing code. In the dedicated bot’s private chat send `/start CODE` within ten minutes. A code is single-use; the paired Telegram user and chat are enforced by the server. Group chats and unpaired users cannot access company data.

Ask for an existing document, company data, a new summary or a form to fill. Reply directly to the bot’s practice message, or include `#<practice number>`, when providing missing information. Ambiguous attachments are not assigned to an arbitrary practice.

Existing indexed company documents are sent automatically. Generated documents are sent as **Draft — pending accountant review** and added to **Reviews**. The accountant can approve, request corrections or reject. Approval archives a distinct approved copy and notifies the client. Original files and earlier drafts are preserved. Review status is carried by version metadata and Telegram captions so approval does not leave a permanent “DRAFT” watermark on an approved PDF.

Telegram operation IDs and confirmed message IDs are recorded using the reused write-operation journal. Uncertain sends become `unknown`/`needs_review` and never automatically replay. Verify them in the bot conversation before initiating a new request.

## Demo scenarios

The seed creates Aurora Servizi S.r.l., deliberately invalid identifiers, a September energy invoice, bank/sales CSVs, company knowledge, Office/PDF examples and six internal preparation deadlines. The EUR 340 Forniture Demo invoice is deliberately absent.

Try in chat:

- “Collect September 2026 invoices, compare with the bank movements and request documented missing invoices.”
- “Prepare a September expense summary using only supported amounts and list unresolved items.”
- “Inspect templates/company-form.docx and fill it with company data. Ask the client for missing declarations.”
- “Create an Excel expense report with source references.”

In **Calendar**, advance the demo clock and run the check. The initial clock is frozen before the first trigger. Dates are internal examples, not a certified statutory calendar. Each event starts a different preparation task; no payments or tax submissions occur. Disable events that should not contact the paired client.

## Document capabilities and limits

DOCX replacement supports `{{field}}` placeholders, including placeholders split across Word runs. Exact text replacement mappings are supported after inspection, and new DOCX files support paragraphs and tables. Complex forms may require an explicit mapping or a new draft rather than identical layout reproduction. XLSX updates preserve existing formulas and reject overwriting formula cells. Arithmetic totals use integer cents. Formula recalculation by Excel/LibreOffice is distinct from stored cached results.

PDF fields and explicit static-page overlays are supported. OCR returns text and areas for scans/images; PDF OCR is limited to the first 12 pages. OCR pixel coordinates use a top-left origin at 120 dpi; PDF overlays use points with a bottom-left origin. The agent must inspect before filling and must not guess placements. Files over 25 MiB, invalid archives, protected/corrupt files and unsupported formats fail visibly. Telegram has a conservative 20 MiB demo file limit.

Extraction/generation runs in a worker with a 384 MiB V8 heap and a 120-second deadline; external OCR commands have their own deadlines. Container resource limits add a separate boundary. These limits do not guarantee that arbitrary forms can always be filled or that OCR is correct. The conversion tool emits a normalized content PDF in the supplied minimal container; original Office layout and formula recalculation are not reproduced. If a custom tool image includes LibreOffice, layout conversion can use it. Failures remain explicit.

## Reused components

Action Center owns practice records and statuses. Calendar MCP uses a company-local backend. LLM Wiki’s MCP interface, paging and Markdown/wiki-link graph format are adapted to company-local knowledge, without the personal Tauri desktop process. Documents MCP reuses readers, archive budgets and worker patterns. Shell MCP reuses the parser and output bounds but exposes only narrowly scoped operations. The existing MCP bridge, Pi host provider, scheduler, watch engine, audit, usage ledger, write-operation journal and React UI primitives are retained.

Company-source documents and the wiki are retrieval sources; SQLite remains authoritative for practice states, roles, revisions, deadlines and delivery outcomes. Tools cannot approve drafts or elevate a Telegram client to accountant. File writes requiring approval are surfaced in **Reviews**.

## Verification and resetting

```sh
npm run wetrop:test
npm run wetrop:build
```

Tests use synthetic files inside `.runtime/tests`. Telegram transport tests use a fake API and never message real users. For live AI acceptance with simulated company messages, sign in and run:

```sh
npm run wetrop:acceptance
npm run wetrop:storage-test
npm run wetrop:portable-test
npm run wetrop:e2e
```

Acceptance uses the real model, real MCP stdio servers, real isolated Docker execution, persistent jobs and actual document/review functions. Only Telegram HTTP transport is simulated. Evidence and delivered files are saved under `.runtime/acceptance/<run>/`; each run has a separate company root. See [verification](apps/wetrop/VERIFICATION.md) for outcomes and limitations. Real Telegram network delivery still requires a dedicated bot and pairing. An unconfigured model produces a visible failed job.

Stop the broker and tools before reset:

```sh
docker compose -f compose.wetrop.yml down
npm run wetrop:reset -- --confirm
```

Reset requires the demo marker. It moves the entire old company folder into `.runtime/reset-archive-*` and creates a fresh demo. Nothing in the original Steward checkout or in personal application data is touched. Previous Telegram pairing is removed; pair again. The web access key and private config remain local to `.runtime/`.
