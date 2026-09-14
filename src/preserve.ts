/**
 * Minimal-diff saving.
 *
 * The editor re-serializes the whole document, which normalizes formatting
 * (escapes, table padding, blank lines…). To keep git diffs to what you
 * actually changed, we compare three versions:
 *
 *   original  – the body as it was on disk
 *   baseline  – the editor's serialization of `original`
 *   current   – the editor's serialization of the edited document
 *
 * Lines of `baseline` that survive unchanged into `current` are written back
 * using the original's bytes; only edited regions use the serializer output.
 * Callers must verify the result parses to the same document as `current`
 * (see `bodyToSave` in editor.ts) and fall back to `current` otherwise.
 */

import { diffArrays } from "diff";

/** A run of baseline lines and the original lines they came from. */
interface Chunk {
  bStart: number;
  bEnd: number;
  oStart: number;
  oEnd: number;
}

export function preserveUnchanged(original: string, baseline: string, current: string): string {
  const o = lines(original);
  const b = lines(baseline);
  const c = lines(current);

  const chunks = alignChunks(o, b);

  // Which baseline lines survive into `current`, and what gets inserted where.
  const kept: boolean[] = new Array(b.length).fill(false);
  const insertBefore = new Map<number, string[]>();
  let bi = 0;
  for (const change of diffArrays(b, c)) {
    if (change.added) {
      insertBefore.set(bi, [...(insertBefore.get(bi) ?? []), ...change.value]);
    } else {
      if (!change.removed) kept.fill(true, bi, bi + change.count);
      bi += change.count;
    }
  }

  const out: string[] = [];
  const flushed = new Set<number>();
  const flushInsert = (at: number) => {
    if (flushed.has(at)) return;
    flushed.add(at);
    out.push(...(insertBefore.get(at) ?? []));
  };

  for (const chunk of chunks) {
    const { bStart, bEnd, oStart, oEnd } = chunk;
    if (bStart === bEnd) {
      // Original-only lines (usually extra blank lines the serializer
      // collapsed): keep them while their surroundings are untouched.
      const quiet =
        !insertBefore.has(bStart) &&
        (bStart === 0 || kept[bStart - 1]) &&
        (bStart === b.length || kept[bStart]);
      if (quiet) out.push(...o.slice(oStart, oEnd));
      continue;
    }

    flushInsert(bStart);
    let untouched = true;
    for (let i = bStart; i < bEnd; i++) {
      if (!kept[i] || (i > bStart && insertBefore.has(i))) untouched = false;
    }
    if (untouched) {
      out.push(...o.slice(oStart, oEnd));
    } else {
      for (let i = bStart; i < bEnd; i++) {
        if (i > bStart) flushInsert(i);
        if (kept[i]) out.push(b[i]);
      }
    }
  }
  flushInsert(b.length);
  return out.join("\n");
}

/** Pairs each baseline line (or replaced run) with its original lines. */
function alignChunks(o: string[], b: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  const changes = diffArrays(o, b);
  let oi = 0;
  let bi = 0;
  let k = 0;
  while (k < changes.length) {
    const change = changes[k];
    if (!change.added && !change.removed) {
      for (let n = 0; n < change.count; n++) {
        chunks.push({ bStart: bi + n, bEnd: bi + n + 1, oStart: oi + n, oEnd: oi + n + 1 });
      }
      oi += change.count;
      bi += change.count;
      k++;
      continue;
    }
    let oCount = 0;
    let bCount = 0;
    while (k < changes.length && (changes[k].added || changes[k].removed)) {
      if (changes[k].removed) oCount += changes[k].count;
      else bCount += changes[k].count;
      k++;
    }
    chunks.push({ bStart: bi, bEnd: bi + bCount, oStart: oi, oEnd: oi + oCount });
    oi += oCount;
    bi += bCount;
  }
  return chunks;
}

function lines(text: string): string[] {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed === "" ? [] : trimmed.split("\n");
}
