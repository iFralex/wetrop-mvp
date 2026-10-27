# Bundled synthetic demonstration data

`aurora/` is a self-contained company snapshot generated specifically for public distribution. All company identifiers and documents are synthetic.

Included: original invoices and movement CSVs; DOCX/XLSX/PDF templates, a fillable PDF and an OCR image/scanned PDF; generated and approved example documents; source-backed wiki and graph; SQLite databases for practices/reviews/calendar, scheduler watches, audit and usage.

The three example practices show a missing supplier invoice, an expense draft awaiting review and an approved expense summary. Six internal preparation deadlines are configured. The EUR 340 supplier invoice is intentionally missing. The demo clock is frozen before automatic triggers.

The snapshot has no Telegram bindings, pairing codes, provider credentials, account sessions, executable jobs or pending sends. Its audit records describe synthetic fixture construction, not real customer communication. OCR template examples are independent samples and are not September ledger entries.

From a fresh checkout:

```sh
npm ci --ignore-scripts
npm run wetrop:demo:restore
npm run wetrop:tools
npm run wetrop:build
npm start
```

Restore verifies every file against `manifest.json` and refuses to overwrite a non-empty `company/`. The application works on its private `company/` copy; the bundled snapshot remains unchanged. Configure ChatGPT and pair a dedicated Telegram bot separately.

To regenerate the bundled snapshot from source, use `npm run wetrop:demo:snapshot`. An existing marked snapshot is archived under `.runtime/` before replacement. All generated files remain inside the checkout.
