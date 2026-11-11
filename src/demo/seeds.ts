import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Candidate } from "../agents/miner.js";

/**
 * The statements the demo works with. One file per article: true statements the miners consider bonding to, and lies the demo
 * can inject. Every one is checkable against the Wikipedia pages that ship in `seed-cache/`, so the demo runs offline.
 */
export interface SeedClaim { key?: string; text: string; section?: string }
export interface SeedLie { text: string; section?: string; note?: string }
export interface SeedFile { topic: string; claims: SeedClaim[]; lies?: SeedLie[] }

export interface LieOption {
  id: string;
  topic: string;
  text: string;
  note: string;
}

export const MAX_TOPIC = 64;
const SLUG = /^[a-z0-9_:-]{1,40}$/;

export const topicOf = (file: Pick<SeedFile, "topic">, section?: string) => (section ? `${file.topic}/${section}` : file.topic);

export function loadSeedDir(dir: string): SeedFile[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as SeedFile);
}

/** Everything that can be checked without touching a chain. Throws a message that names the file and the problem. */
export function validateSeeds(files: SeedFile[]): void {
  const topics = new Set<string>();
  const texts = new Set<string>();
  for (const f of files) {
    if (!SLUG.test(f.topic)) throw new Error(`seed "${f.topic}": topic must be lower-case letters, digits, - _ :`);
    if (topics.has(f.topic)) throw new Error(`seed "${f.topic}": two files for one article`);
    topics.add(f.topic);
    const check = (text: string, section: string | undefined, what: string) => {
      if (section !== undefined && !SLUG.test(section)) throw new Error(`seed "${f.topic}": bad section "${section}" on ${what}`);
      if (!text || text.length < 8 || text.length > 280) throw new Error(`seed "${f.topic}": ${what} must be 8 to 280 characters`);
      if (topicOf(f, section).length > MAX_TOPIC) throw new Error(`seed "${f.topic}": "${topicOf(f, section)}" is longer than the contract's ${MAX_TOPIC}-character topic limit`);
      const k = text.trim().toLowerCase();
      if (texts.has(k)) throw new Error(`seed "${f.topic}": "${text}" appears twice`);
      texts.add(k);
    };
    f.claims.forEach((c, i) => check(c.text, c.section, `claim ${i}`));
    (f.lies ?? []).forEach((l, i) => check(l.text, l.section, `lie ${i}`));
  }
}

export function factsOf(files: SeedFile[]): Candidate[] {
  return files.flatMap((f) => f.claims.map((c) => ({ topic: topicOf(f, c.section), text: c.text })));
}

export function liesOf(files: SeedFile[]): LieOption[] {
  return files.flatMap((f) => (f.lies ?? []).map((l, i) => ({ id: `${f.topic}-${i}`, topic: topicOf(f, l.section), text: l.text, note: l.note ?? "" })));
}

/** Deals candidates to `n` miners in turn, so two miners never work the same statement. */
export function deal<T>(items: T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: n }, () => []);
  items.forEach((x, i) => out[i % n]!.push(x));
  return out;
}
