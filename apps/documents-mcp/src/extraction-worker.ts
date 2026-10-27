import { parentPort, workerData } from 'node:worker_threads';
import { extractByType } from './extraction.ts';

try {
  const result = await extractByType(workerData.path, workerData.extension);
  const maxChars = Math.min(Math.max(Number(process.env.DOCUMENT_MAX_EXTRACTED_CHARS) || 8_000_000, 1_000), 32_000_000);
  if (result.pages.reduce((n, page) => n + page.text.length, 0) > maxChars) throw new Error('Extracted document exceeds character budget');
  parentPort!.postMessage({ result });
} catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
