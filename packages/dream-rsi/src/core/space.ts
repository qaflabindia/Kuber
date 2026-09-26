/**
 * Bounded parameter spaces. A policy family declares its parameters twice, on purpose: a zod
 * schema (the hard bounds every candidate must pass before it is evaluated, whoever proposed it)
 * and a list of dimensions (how the default proposer moves inside those bounds). open-dream-rsi
 * hard-codes TEMP_MIN/TEMP_MAX and DEPTH_MIN/DEPTH_MAX and clamps every mutation; this is the same
 * idea for any number of named parameters.
 */
import { roundTo } from "./util.ts";

export interface Dim {
  /** Path of the parameter inside the parameter object, e.g. ["toolPriors", "report"]. */
  path: readonly string[];
  min: number;
  max: number;
  /** Largest local move per mutation (open-dream-rsi: ±0.1 temperature, ±0.5 depth). */
  step: number;
  integer?: boolean;
  /** null is a valid value (e.g. "off"); the proposer toggles between null and a value. */
  nullable?: boolean;
  /** Decimals kept after a move (integers: 0). */
  precision?: number;
}
export type ParamSpace = readonly Dim[];

export const dimKey = (d: Dim) => d.path.join(".");

export function getAt(obj: unknown, path: readonly string[]): unknown {
  let cur = obj;
  for (const k of path) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

/** A copy of `obj` with `path` set to `value`. */
export function setAt<T>(obj: T, path: readonly string[], value: unknown): T {
  const out = structuredClone(obj) as Record<string, unknown>;
  let cur = out;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    cur[k] = { ...((cur[k] as Record<string, unknown>) ?? {}) };
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
  return out as T;
}

/** Clamp to the dimension's bounds and precision. */
export function clampDim(d: Dim, v: number): number {
  const c = Math.min(d.max, Math.max(d.min, v));
  return d.integer ? Math.round(c) : roundTo(c, d.precision ?? 4);
}

/** Parameters that differ between two parameter objects, by dimension. */
export function diffParams(space: ParamSpace, from: unknown, to: unknown): { param: string; from: unknown; to: unknown }[] {
  const out: { param: string; from: unknown; to: unknown }[] = [];
  for (const d of space) {
    const a = getAt(from, d.path), b = getAt(to, d.path);
    if (a !== b) out.push({ param: dimKey(d), from: a ?? null, to: b ?? null });
  }
  return out;
}
