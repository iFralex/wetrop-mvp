# Documents MCP

Read-only local document extraction and bounded hybrid search for Steward.

## Tools

- `document_info`: metadata, page/character counts, warnings, and up to 50 headings.
- `document_read`: cursor-based reading, 6,000 characters and one page by default; hard caps of 12,000 characters and three pages.
- `document_search`: full-document lexical search fused with semantic embeddings when the gateway is available. Results contain only bounded excerpts and cursors for `document_read`.

Supported formats are PDF, Markdown and other UTF-8 text/data formats, HTML, RTF, DOCX, PPTX, and ODT. Image-only PDFs report `no_extractable_text`; OCR is intentionally not automatic.

## Safety and limits

- absolute, canonical paths only;
- shared `@steward/sensitive-path` checks before and after symlink resolution;
- regular files and allow-listed extensions only;
- 25 MB default size limit (`DOCUMENT_MAX_BYTES`, capped at 100 MB);
- 15 second extraction worker deadline (`DOCUMENT_EXTRACT_TIMEOUT_MS`, 1–60 seconds); timeout terminates parser execution;
- parser V8 old heap defaults to 256 MiB (`DOCUMENT_WORKER_HEAP_MB`, 64–512), with eight million extracted characters (`DOCUMENT_MAX_EXTRACTED_CHARS`, cap 32 million);
- Office ZIP declared expansion defaults to 64 MiB (`DOCUMENT_ARCHIVE_MAX_BYTES`, cap 256 MiB), with at most 10,000 entries; ZIP64/multipart input is rejected;
- text/chunks/vectors use an eight-entry LRU with a 64 MiB estimated aggregate budget (`DOCUMENT_CACHE_MAX_BYTES`, cap 256 MiB), keyed by canonical path, size and mtime. No persistent document index.

Embeddings default to Steward's gateway and are attributed as service `documents-mcp`, action `search-embed`. Override with `DOCUMENT_EMBED_ENDPOINT`, `DOCUMENT_EMBED_MODEL`, `DOCUMENT_EMBED_API_KEY`, and `DOCUMENT_EMBED_DIM`; set `DOCUMENT_EMBED_ENDPOINT=off` for lexical-only search.

The host's common MCP wrapper records every `document_info`, `document_read`, and `document_search` execution in both the Usage ledger and Audit log, including duration, outcome, inputs, output and file source references. Audit payloads have bounded heuristic redaction; primary chat/tool transcripts are separate stores.

## Retrieval and continuation

Search chunks extracted text into nominal 1,800-character segments with
200-character overlap. Lexical ranking covers the whole extracted document;
semantic search embeds at most 256 evenly spaced chunks in batches of 64 and
compares cosine similarity. Each ranking contributes up to 50 candidates to RRF.
Results default to five 300-character excerpts, with caps of ten and 800 context
characters (ellipsis markers can add characters).

`search.semantic` reports `disabled`, `unavailable`, `full`, `sampled` or `partial`.
Counts distinguish selected chunks from usable vectors; full coverage requires
all selected vectors and no sampling. Missing vectors are retried on a later
query; endpoint/model/dimension changes invalidate cached vectors. Failures leave
lexical results usable and partial/sampled coverage emits a warning.

Search and outline cursors encode page/offset plus a fingerprint of canonical
path, size and mtime. Old/unversioned cursors are rejected after ordinary edits;
repeat info/search to obtain current cursors. Extraction rejects concurrent stat
changes. This is continuation versioning, not a cryptographic immutable citation.
`page` and `cursor` are mutually exclusive. Plain text, DOCX and ODT have one
logical page; PDF pages and PPTX slides retain their divisions. Layout fidelity
and OCR are outside the extraction contract.

Full-file parsers execute in terminable workers. V8 heap, declared ZIP sizes and
estimated cache bytes do not bound every native allocation or provide an OS
sandbox. Canonical path checks are defense in depth against ordinary unsafe paths,
not a guarantee against all concurrent filesystem replacement.

See [the root engineering explanation](../../README.md#bounded-document-reading-and-search)
for the full data flow and cache boundaries.

## Validation

```sh
npm test -w @steward/documents-mcp
```

Tests create local temporary fixtures, inject embedding functions and do not
call real model services. Document writes/ingestion into the wiki are separate
capabilities; these three MCP tools are read-only.
