# Verification — 27 October 2026

Wetrop was exercised locally on the Mac with Node 24, Docker Desktop and the dedicated ChatGPT account signed in through the official OAuth flow. The selected model is `gpt-6.1-sol`. No Codex or original Steward credentials were copied.

## Actual AI acceptance

The completed seven-scenario run used real ChatGPT inference, the reused Pi host, real MCP stdio servers inside a read-only container with no network, the production JobRunner, real generated files and the production review functions. Only Telegram's HTTP transport was simulated, as authorized: the harness submits actual Telegram-shaped updates and attachments and records the outgoing message/document bytes.

Evidence: `.runtime/acceptance/2026-10-27T16-08-56-687Z/` contains `report.json`, `events.json`, `deliveries.json`, company state and copies of every delivered file.

| Scenario                                  | Observed result                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Company asks for VAT identifier           | Correct seeded identifier, explicitly described as synthetic                                                                                                        |
| Company requests September energy invoice | Existing original sent automatically                                                                                                                                |
| Accountant requests invoice collection    | Agent identifies the missing EUR 340 invoice, asks the company, receives its PDF reply, resumes the same practice and packages invoices plus CSV index for approval |
| Company requests expense summary          | PDF delivered as a draft before studio approval; accountant correction produces a new version and subsequent approval                                               |
| Company submits DOCX form                 | Agent asks for the missing declaration, uses the reply and fills the form; studio can approve it                                                                    |
| VAT preparation deadline                  | Associated practice created and processed; repeated tick does not create a duplicate                                                                                |
| Malicious client request                  | No private filesystem/database content disclosed and no client self-approval                                                                                        |

Generated summary PDFs were also read back and inspected: expenses EUR 462, incoming movement EUR 1,220, net movements EUR +758. The output distinguishes cash movements from account balance/profit and separates sales CSV evidence from original invoices.

## Corrections made after observed failures

- Container tools use Node's TypeScript transform instead of a Mac-native esbuild executable.
- Fresh-install verification also migrated the scheduler watch store to the same Node SQLite adapter, removing its native SQLite build requirement.
- SQLite now stays on the host kernel. Linux MCP servers exchange company-local JSON requests with a host bridge rather than opening SQLite files on Docker Desktop's bind mount. Earlier direct cross-kernel access caused lost updates and corruption; merely changing WAL to rollback journals was insufficient.
- Tool side effects have persistent operation records. Confirmed identical operations are reused on retry, uncertain writes block automatic replay, and explicit validation errors permit corrected inputs.
- Provider failures and interrupted/partial model turns remain failed jobs; partial text does not count as successful completion.
- Approval and delivery verify source fingerprints, rejecting files altered after indexing.
- OCR uses offline Italian/English WASM models and a Linux canvas binding. A PDF parser cleanup failure found during real container testing was corrected and retested.
- PDF text normalizes common punctuation/currency and wraps on measured word boundaries. Draft status belongs in delivery captions and review metadata; the agent is instructed not to leave permanent draft labels in documents that can later be approved.
- Routine ChatGPT reauthentication reuses the saved registration. Tokens, refresh locks and account state remain private under `.runtime/chatgpt/`.

## Additional completed checks

- **37 automated tests passed**, covering path confinement, traversal/symlink/hardlink rejection, source hashes, role filtering, real MCP transport, provider streaming, PKCE/state/scopes/private token storage/refresh serialization, document adapters, preserved formulas, OCR, persistent practices, calendar deduplication, reminder bounds, review/correction and Telegram delivery recovery/deduplication.
- TypeScript and React production build passed.
- Browser/API smoke passed: access key, invalid authentication, private/traversal downloads blocked, all workspace views, actual download, visible missing-provider error, mobile layout and no browser JavaScript errors.
- Real container storage stress: **100/100 concurrent host/guest updates**, SQLite integrity check OK; private tokens absent, source mounts read-only and network access denied. Evidence: `.runtime/acceptance/storage-test.log`.
- Real container document adapters: offline OCR of both PNG and scanned PDF; PDF field filling; static scanned-PDF overlay; XLSX filled to EUR 462 while preserving its original formula; Office content PDF preview with explicit layout warning. Evidence: `.runtime/acceptance/portable-test.log`.
- Updated broker on port 4417 reports the ChatGPT account connected and model configured. Telegram is correctly reported as unconfigured.
- Original `<original Steward checkout>` has no tracked modifications. Its pre-existing untracked `artifacts/` remains untouched. The clone has no Git remote pointing back at the original checkout.

## Incomplete checks and limits

The expanded nine-scenario AI run stopped during the PDF-summary scenario because the provider returned:

> The ChatGPT user has reached their Subscription Sharing usage limit.

It did not complete the added end-to-end XLSX and image scenarios. Those adapters were successfully tested directly in the real isolated container; this is distinct from an autonomous model-driven flow. A separate model-driven restart scenario also hit the same usage limit before completing. Database reopening, queued continuation persistence and Telegram reply correlation pass automated tests, but the full model-driven process restart must still be rerun after the limit resets. No automatic retries are consuming more subscription quota.

The interrupted runs are preserved at `.runtime/acceptance/2026-10-27T16-24-49-124Z/` and `.runtime/acceptance/2026-10-27T16-28-08-061Z/`. Their failed jobs and any intermediate files remain inspectable; they are not reported as delivered results.

Real Telegram network delivery has not been tested because no dedicated bot exists yet. No real Telegram recipient was contacted. Pairing and ingress/egress were tested with simulated HTTP transport.

The supplied minimal container produces a **normalized content PDF preview** for Office files. It does not reproduce arbitrary Word/Excel layout or recalculate formulas. OCR can be wrong, PDF OCR is capped at 12 pages, and complex/protected/unreadable forms can require mapping or an alternative. A successful test on synthetic forms is not evidence that every arbitrary document can be filled automatically.

The dependency audit records seven inherited advisories (four moderate, three high; none critical), detailed in `.runtime/dependency-audit.json`. This is a local demonstration, not a production security release or a certified fiscal system. No tax filing, payment, push or deployment was performed.

## Public release checks

A fresh `npm ci --ignore-scripts` install and production build passed. The clean copy passed all 37 Wetrop tests and eight watch-engine tests. The bundled synthetic snapshot contains four integrity-checked SQLite databases, three example practices and six deadlines. Restore verifies file checksums, preserves document hashes, contains no bindings/pending sends/jobs, and refuses to overwrite a populated company folder. Runtime credentials and live account state are excluded from Git.

## Reproduction

```sh
npm run wetrop:test
npm run wetrop:build
npm run wetrop:tools
npm run wetrop:storage-test
npm run wetrop:portable-test
npm run wetrop:e2e
# After the ChatGPT sharing allowance resets:
npm run wetrop:acceptance
# Focus only on collection plus restart:
WETROP_ACCEPTANCE_SCENARIO=collection npm run wetrop:acceptance
```

Every acceptance run gets its own company folder under `.runtime/acceptance/`. Future runs also direct host audit/usage into that company root; early live runs wrote the host ledger into the clone's default demo company. No data was written into original Steward or personal application stores.
