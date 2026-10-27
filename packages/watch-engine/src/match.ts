import type { DomainEvent, WatchRule } from "./types.ts";

export function matchesRule(rule: WatchRule, event: DomainEvent): boolean {
  if (!rule.event) return false;
  if (rule.event !== event.type) return false;
  return Object.entries(rule.where ?? {}).every(([path, expected]) => deepEqual(readPath(event.data, path), expected));
}

export function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "string" && typeof right === "string") {
    return left.trim().localeCompare(right.trim(), undefined, { sensitivity: "base" }) === 0;
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}
