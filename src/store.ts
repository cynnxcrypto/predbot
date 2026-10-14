import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, dayOf } from "./config.js";

/**
 * Plain JSON-lines files, one per kind per UTC day: data/<kind>/<day>.jsonl.
 * Anything (Python, DuckDB, a spreadsheet) can read them later.
 */
export function append(kind: string, row: Record<string, unknown>, atMs = Date.now()) {
  const dir = join(DATA, kind);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${dayOf(atMs)}.jsonl`), JSON.stringify(row) + "\n");
}

export function readAll<T>(kind: string): T[] {
  const dir = join(DATA, kind);
  if (!existsSync(dir)) return [];
  const rows: T[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as T);
      } catch {
        // a half-written last line after a crash is dropped
      }
    }
  }
  return rows;
}

/** Atomic JSON write for small state files (write to a temp file, then rename). */
export function saveJson(name: string, value: unknown) {
  mkdirSync(DATA, { recursive: true });
  const file = join(DATA, name);
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  renameSync(file + ".tmp", file);
}

export function loadJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(DATA, name), "utf8")) as T;
  } catch {
    return fallback;
  }
}
