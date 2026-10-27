import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Schemes we'll render as a clickable link — everything else (javascript:, data:, etc.) is stripped. */
const SAFE_HREF = /^(https?:|mailto:|message:)/i;
export function safeHref(href: string | undefined): string | undefined {
  return href && SAFE_HREF.test(href.trim()) ? href : undefined;
}

/**
 * A random id. `crypto.randomUUID` exists only in a secure context (https or
 * localhost); over plain http on the phone it's undefined, so fall back to a
 * good-enough random string (these ids are only local React keys).
 */
export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
