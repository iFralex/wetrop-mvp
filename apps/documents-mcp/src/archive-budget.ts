/** Check ZIP central-directory sizes before any DOCX/PPTX/ODT inflation. ZIP64 is rejected. */
export function validateArchiveBudget(bytes: Buffer, maxBytes = Math.min(Number(process.env.DOCUMENT_ARCHIVE_MAX_BYTES) || 64 * 1024 * 1024, 256 * 1024 * 1024)): void {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw new Error('Invalid document ZIP directory');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16);
  if (count === 65535 || count > 10_000 || offset === 0xffffffff || bytes.readUInt16LE(end + 4) !== 0) throw new Error('ZIP64, multipart or oversized document archive is unsupported');
  let at = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const size = bytes.readUInt32LE(at + 24);
    if (size === 0xffffffff) throw new Error('ZIP64 document entries are unsupported');
    total += size;
    if (total > maxBytes) throw new Error('Document archive exceeds decompressed size budget');
    at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  if (at > end) throw new Error('Invalid ZIP directory bounds');
}
