/**
 * Ranked retrieval over a disposable SQLite FTS5 index built from `bd export`.
 *
 * The database is deliberately a cache. Beads remains the source of truth and
 * this program never writes to Beads or to its database.
 */

import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = "3";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const RRF_K = 60;
// The order must match the FTS columns below. Titles and decision-oriented
// fields carry the most retrieval signal; comments are intentionally weakest
// because long discussion threads otherwise dominate BM25 scoring.
const BM25_WEIGHTS = [
  12, // title
  5, // description
  8, // design
  7, // acceptance_criteria
  3, // notes
  2, // close_reason
  1, // comments
];
const FIELDS = [
  "title",
  "description",
  "design",
  "acceptance_criteria",
  "notes",
  "close_reason",
  "comments",
] as const;

export type IndexedIssue = {
  id: string;
  title: string;
  description: string;
  design: string;
  acceptance_criteria: string;
  notes: string;
  close_reason: string;
  comments: string;
  status: string;
  priority: number;
  issue_type: string;
  updated_at: string;
};

export type SearchResult = {
  issue_id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  updated_at: string;
  path: string;
  score: number;
};

export type ExportRunner = (
  onIssue: (issue: IndexedIssue) => Promise<void> | void,
) => Promise<void>;

type IndexMetadata = Record<string, string>;
export type FreshnessState = "unchecked" | "current" | "stale" | "rebuilt";

const ASCII_ALNUM = /^[A-Za-z0-9]$/u;
const UNICODE_ALNUM = /^[\p{L}\p{N}]$/u;

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeIssue(
  raw: Record<string, unknown>,
): IndexedIssue | null {
  if (Object.hasOwn(raw, "_schema")) return null;
  if (raw._type !== undefined && raw._type !== "issue") return null;
  const id = text(raw.id);
  if (!id) throw new Error("bd export issue is missing id");
  const comments = Array.isArray(raw.comments)
    ? raw.comments.map((comment) => {
      if (!comment || typeof comment !== "object") return "";
      return text((comment as Record<string, unknown>).text);
    }).filter(Boolean).join("\n")
    : "";
  return {
    id,
    title: text(raw.title),
    description: text(raw.description),
    design: text(raw.design),
    acceptance_criteria: text(raw.acceptance_criteria),
    notes: text(raw.notes),
    close_reason: text(raw.close_reason),
    comments,
    status: text(raw.status),
    priority: numberValue(raw.priority),
    issue_type: text(raw.issue_type || raw.type),
    updated_at: text(raw.updated_at),
  };
}

/**
 * Derive the prose representation for SQLite's unicode61 tokenizer by adding
 * boundaries to mixed-script identifiers. SQLite can otherwise merge an
 * ASCII numeric suffix with adjacent non-ASCII letters. The raw source is
 * supplied separately to trigram_fts.
 * Only ASCII-alphanumeric/non-ASCII-alphanumeric boundaries are separated;
 * punctuation and whitespace are never removed or rewritten.
 */
export function normalizeForProse(value: string): string {
  const characters = [...value];
  let separated = "";
  for (let index = 0; index < characters.length; index++) {
    const current = characters[index];
    if (index > 0) {
      const previous = characters[index - 1];
      const previousAscii = ASCII_ALNUM.test(previous);
      const currentAscii = ASCII_ALNUM.test(current);
      const previousUnicode = UNICODE_ALNUM.test(previous);
      const currentUnicode = UNICODE_ALNUM.test(current);
      const mixedBoundary =
        (previousAscii && currentUnicode && !currentAscii) ||
        (currentAscii && previousUnicode && !previousAscii);
      if (mixedBoundary && !separated.endsWith(" ")) separated += " ";
    }
    separated += current;
  }
  return separated;
}

export function parseWhereJson(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("bd where returned invalid JSON");
  }
  const envelope = parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : undefined;
  const payload = envelope?.data ?? parsed;
  const path = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).path
    : undefined;
  if (typeof path !== "string" || !path) {
    throw new Error("bd where JSON has no path");
  }
  return path;
}

function jsonLine(value: IndexedIssue): string {
  return JSON.stringify({
    id: value.id,
    title: value.title,
    description: value.description,
    design: value.design,
    acceptance_criteria: value.acceptance_criteria,
    notes: value.notes,
    close_reason: value.close_reason,
    comments: value.comments,
    status: value.status,
    priority: value.priority,
    issue_type: value.issue_type,
    updated_at: value.updated_at,
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function fingerprintIssues(
  issues: IndexedIssue[],
): Promise<string> {
  const pairs: string[] = [];
  for (const issue of issues) {
    pairs.push(`${issue.id}\0${await sha256(jsonLine(issue))}`);
  }
  pairs.sort();
  return await sha256(pairs.join("\n"));
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        await onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
    }
    pending += decoder.decode();
    if (pending) {
      await onLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
    }
  } finally {
    reader.releaseLock();
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

type BdResult = { code: number; stdout: string; stderr: string };

async function runBd(args: string[]): Promise<BdResult> {
  let command: Deno.ChildProcess;
  try {
    command = new Deno.Command("bd", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    throw new Error(
      `could not start bd: ${error instanceof Error ? error.message : error}`,
    );
  }
  const stdout = readStream(command.stdout);
  const stderr = readStream(command.stderr);
  const [out, err, status] = await Promise.all([
    stdout,
    stderr,
    command.status,
  ]);
  return { code: status.code, stdout: out, stderr: err };
}

export async function resolveBeadsDir(): Promise<string> {
  const result = await runBd(["where", "--json"]);
  if (result.code !== 0) {
    throw new Error(`bd where failed: ${result.stderr.trim()}`);
  }
  const path = parseWhereJson(result.stdout);
  try {
    return await Deno.realPath(path);
  } catch {
    throw new Error(`bd where path does not exist: ${path}`);
  }
}

export function assertBeadsDirMatch(
  requested: string | undefined,
  effective: string,
): string {
  if (!requested || requested === effective) return effective;
  throw new Error(
    `--beads-dir does not match bd where --json path (${effective})`,
  );
}

async function verifyBeadsDir(requested: string | undefined): Promise<string> {
  const effective = await resolveBeadsDir();
  if (!requested) return effective;
  let supplied: string;
  try {
    supplied = await Deno.realPath(requested);
  } catch {
    throw new Error(`--beads-dir does not exist: ${requested}`);
  }
  return assertBeadsDirMatch(supplied, effective);
}

function indexPath(beadsDir: string): string {
  return `${beadsDir}/search-index.db`;
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (
      rowid INTEGER PRIMARY KEY,
      issue_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE prose_fts USING fts5(
      title, description, design, acceptance_criteria, notes, close_reason, comments,
      content='', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE trigram_fts USING fts5(
      title, description, design, acceptance_criteria, notes, close_reason, comments,
      content='', tokenize='trigram'
    );
  `);
}

export function hasCompatibleSchema(db: DatabaseSync): boolean {
  try {
    const row = db.prepare(
      "SELECT value FROM index_meta WHERE key = 'complete'",
    ).get() as { value?: string } | undefined;
    const version = db.prepare(
      "SELECT value FROM index_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    return row?.value === "true" && version?.value === SCHEMA_VERSION;
  } catch {
    return false;
  }
}

function configureDatabase(db: DatabaseSync, writable = false): void {
  db.exec("PRAGMA busy_timeout = 5000;");
  if (writable) db.exec("PRAGMA journal_mode = WAL;");
}

async function exportIssues(
  onIssue: (issue: IndexedIssue) => Promise<void> | void,
): Promise<void> {
  let command: Deno.ChildProcess;
  try {
    command = new Deno.Command("bd", {
      args: ["export"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    throw new Error(
      `could not start bd export: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  let parseError: Error | undefined;
  const stdoutTask = readLines(command.stdout, async (line) => {
    if (!line.trim() || parseError) return;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const issue = normalizeIssue(raw);
      if (issue) await onIssue(issue);
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
    }
  });
  const stderrTask = readStream(command.stderr);
  const [, stderr, status] = await Promise.all([
    stdoutTask,
    stderrTask,
    command.status,
  ]);
  if (parseError) throw new Error(`bd export JSONL: ${parseError.message}`);
  if (!status.success) {
    throw new Error(
      `bd export failed: ${stderr.trim() || `exit ${status.code}`}`,
    );
  }
}

async function collectIssues(): Promise<IndexedIssue[]> {
  const issues: IndexedIssue[] = [];
  await exportIssues((issue) => {
    issues.push(issue);
  });
  return issues;
}

function dropSchema(db: DatabaseSync): void {
  db.exec(
    "DROP TABLE IF EXISTS prose_fts; DROP TABLE IF EXISTS trigram_fts; DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS index_meta;",
  );
}

export async function buildIndex(
  beadsDir: string,
  beadsVersion: string,
  exportRunner: ExportRunner = exportIssues,
  snapshot?: readonly IndexedIssue[],
): Promise<IndexMetadata> {
  const db = new DatabaseSync(indexPath(beadsDir));
  try {
    configureDatabase(db, true);
    db.exec("BEGIN IMMEDIATE");
    try {
      dropSchema(db);
      createSchema(db);
      const insertDoc = db.prepare(
        "INSERT INTO documents(rowid, issue_id, title, status, priority, issue_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const insertProse = db.prepare(
        "INSERT INTO prose_fts(rowid, title, description, design, acceptance_criteria, notes, close_reason, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertTrigram = db.prepare(
        "INSERT INTO trigram_fts(rowid, title, description, design, acceptance_criteria, notes, close_reason, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const pairs: string[] = [];
      let rowid = 0;
      const source: ExportRunner = snapshot
        ? async (onIssue) => {
          for (const issue of snapshot) await onIssue(issue);
        }
        : exportRunner;
      await source(async (issue) => {
        rowid += 1;
        const fields = FIELDS.map((field) => issue[field]);
        const proseFields = fields.map(normalizeForProse);
        insertDoc.run(
          rowid,
          issue.id,
          issue.title,
          issue.status,
          issue.priority,
          issue.issue_type,
          issue.updated_at,
        );
        insertProse.run(rowid, ...proseFields);
        insertTrigram.run(rowid, ...fields);
        pairs.push(`${issue.id}\0${await sha256(jsonLine(issue))}`);
      });
      pairs.sort();
      const fingerprint = await sha256(pairs.join("\n"));
      const setMeta = db.prepare(
        "INSERT INTO index_meta(key, value) VALUES (?, ?)",
      );
      setMeta.run("complete", "true");
      setMeta.run("schema_version", SCHEMA_VERSION);
      setMeta.run("fingerprint", fingerprint);
      setMeta.run("issue_count", String(rowid));
      setMeta.run("built_at", new Date().toISOString());
      setMeta.run("beads_version", beadsVersion);
      db.exec("COMMIT");
      return readMetadata(db);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function readMetadata(db: DatabaseSync): IndexMetadata {
  const rows = db.prepare("SELECT key, value FROM index_meta").all() as Array<
    { key: string; value: string }
  >;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function getBeadsVersion(): Promise<string> {
  const result = await runBd(["--version"]);
  return result.code === 0 ? result.stdout.trim() : "unknown";
}

function openIndex(
  beadsDir: string,
): { db: DatabaseSync; metadata: IndexMetadata } | null {
  try {
    const db = new DatabaseSync(indexPath(beadsDir), { readOnly: true });
    configureDatabase(db);
    if (!hasCompatibleSchema(db)) {
      db.close();
      return null;
    }
    return { db, metadata: readMetadata(db) };
  } catch {
    return null;
  }
}

export function ftsQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function proseTerms(query: string): string[] {
  return query.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function trigramTerms(query: string): string[] {
  return query.split(/\s+/u).filter((term) => [...term].length >= 3);
}

type RankedRow = { rowid: number; score: number };

function rankedRows(
  db: DatabaseSync,
  table: "prose_fts" | "trigram_fts",
  match: string,
  openOnly: boolean,
): RankedRow[] {
  const weights = `, ${BM25_WEIGHTS.join(", ")}`;
  const statusFilter = openOnly ? " AND d.status <> 'closed'" : "";
  const sql =
    `SELECT ${table}.rowid, bm25(${table}${weights}) AS score FROM ${table} JOIN documents AS d ON d.rowid = ${table}.rowid WHERE ${table} MATCH ?${statusFilter} ORDER BY score LIMIT ?`;
  return (db.prepare(sql).all(match, MAX_LIMIT * 5) as Array<
    { rowid: number; score: number }
  >).map((row) => ({ rowid: Number(row.rowid), score: Number(row.score) }));
}

function addRanks(
  target: Map<
    number,
    { rank: number; path: Set<string>; tier: number; score: number }
  >,
  rows: RankedRow[],
  path: string,
  tier: number,
): void {
  rows.forEach((row, index) => {
    const rank = index + 1;
    const previous = target.get(row.rowid);
    if (previous) {
      previous.path.add(path);
      previous.tier = Math.min(previous.tier, tier);
      previous.score += 1 / (RRF_K + rank);
    } else {
      target.set(row.rowid, {
        rank,
        path: new Set([path]),
        tier,
        score: 1 / (RRF_K + rank),
      });
    }
  });
}

export function searchIndex(
  db: DatabaseSync,
  query: string,
  limit: number,
  openOnly: boolean,
): SearchResult[] {
  const terms = proseTerms(normalizeForProse(query));
  const rawTrigrams = trigramTerms(query);
  if (!terms.length && !rawTrigrams.length) return [];
  const ranked = new Map<
    number,
    { rank: number; path: Set<string>; tier: number; score: number }
  >();
  if (terms.length) {
    const all = terms.map(ftsQuote).join(" AND ");
    const any = terms.map(ftsQuote).join(" OR ");
    addRanks(ranked, rankedRows(db, "prose_fts", all, openOnly), "prose", 0);
    if (any !== all) {
      addRanks(
        ranked,
        rankedRows(db, "prose_fts", any, openOnly),
        "prose-any",
        1,
      );
    }
  }
  if (rawTrigrams.length) {
    const all = rawTrigrams.map(ftsQuote).join(" AND ");
    addRanks(
      ranked,
      rankedRows(db, "trigram_fts", all, openOnly),
      "trigram",
      0,
    );
    const any = rawTrigrams.map(ftsQuote).join(" OR ");
    if (any !== all) {
      addRanks(
        ranked,
        rankedRows(db, "trigram_fts", any, openOnly),
        "trigram-any",
        1,
      );
    }
  }
  const get = db.prepare(
    "SELECT issue_id, title, status, priority, issue_type, updated_at FROM documents WHERE rowid = ?",
  );
  const candidates: Array<{
    document: Omit<SearchResult, "path" | "score">;
    info: { path: Set<string>; tier: number; score: number };
  }> = [];
  for (const [rowid, info] of ranked) {
    const document = get.get(rowid) as
      | Omit<SearchResult, "path" | "score">
      | undefined;
    if (!document || (openOnly && document.status === "closed")) continue;
    candidates.push({ document, info });
  }
  candidates.sort((a, b) => {
    if (a.info.tier !== b.info.tier) return a.info.tier - b.info.tier;
    if (a.info.score !== b.info.score) return b.info.score - a.info.score;
    const updated = b.document.updated_at.localeCompare(a.document.updated_at);
    if (updated !== 0) return updated;
    return a.document.issue_id.localeCompare(b.document.issue_id);
  });
  const results: SearchResult[] = [];
  for (const { document, info } of candidates) {
    results.push({
      ...document,
      path: [...info.path].sort().join("+"),
      score: info.score,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function printSearch(results: SearchResult[], json: boolean): void {
  if (json) {
    console.log(formatSearchJson(results));
    return;
  }
  if (!results.length) {
    console.log("No matching issues found.");
    return;
  }
  console.log("rank\tid\tstatus\tpath\ttitle");
  results.forEach((result, index) =>
    console.log(
      `${index + 1}\t${result.issue_id}\t${result.status}\t${result.path}\t${
        result.title.replaceAll("\n", " ")
      }`,
    )
  );
}

export function formatSearchJson(results: SearchResult[]): string {
  return JSON.stringify(
    results.map((result, index) => ({ rank: index + 1, ...result })),
  );
}

function printStatus(status: Record<string, unknown>, json: boolean): void {
  if (json) console.log(JSON.stringify(status));
  else {
    console.log(
      Object.entries(status).map(([key, value]) => `${key}: ${value}`).join(
        "\n",
      ),
    );
  }
}

export function formatIndexNotice(
  metadata: IndexMetadata,
  freshness: FreshnessState,
): string {
  const fields = [
    "beads-search-full: index=ready",
    `freshness=${freshness}`,
  ];
  if (metadata.built_at) fields.push(`built_at=${metadata.built_at}`);
  if (metadata.issue_count) fields.push(`issues=${metadata.issue_count}`);
  if (freshness === "stale") fields.push("action=use --fresh or reindex");
  return fields.join("; ");
}

async function inspectFreshness(
  beadsDir: string,
): Promise<{
  current: boolean;
  fingerprint: string;
  issue_count: number;
  issues: IndexedIssue[];
}> {
  const issues = await collectIssues();
  const fingerprint = await fingerprintIssues(issues);
  const opened = openIndex(beadsDir);
  const stored = opened?.metadata.fingerprint;
  const issueCount = issues.length;
  opened?.db.close();
  return {
    current: stored === fingerprint,
    fingerprint,
    issue_count: issueCount,
    issues,
  };
}

export function parseArgs(
  args: string[],
): {
  command: string;
  query: string;
  beadsDir?: string;
  limit: number;
  open: boolean;
  json: boolean;
  fresh: boolean;
  check: boolean;
} {
  let beadsDir: string | undefined;
  let limit = DEFAULT_LIMIT;
  let open = false;
  let json = false;
  let fresh = false;
  let check = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--beads-dir") beadsDir = args[++index];
    else if (arg.startsWith("--beads-dir=")) {
      beadsDir = arg.slice("--beads-dir=".length);
    } else if (arg === "--limit") limit = Number(args[++index]);
    else if (arg.startsWith("--limit=")) {
      limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--open") open = true;
    else if (arg === "--json") json = true;
    else if (arg === "--fresh") fresh = true;
    else if (arg === "--check") check = true;
    else if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    } else positional.push(arg);
  }
  const command = positional.shift() ?? "";
  return {
    command,
    query: positional.join(" "),
    beadsDir,
    limit,
    open,
    json,
    fresh,
    check,
  };
}

function usage(): never {
  throw new Error(
    "usage: search.ts [--beads-dir PATH] search [--limit N] [--open] [--json] [--check|--fresh] QUERY | reindex [--json] | status [--check] [--json]",
  );
}

export async function main(args = Deno.args): Promise<void> {
  const options = parseArgs(args);
  if (
    !options.command ||
    !["search", "reindex", "status"].includes(options.command)
  ) usage();
  if (
    !Number.isInteger(options.limit) || options.limit < 1 ||
    options.limit > MAX_LIMIT
  ) throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  if (options.command === "search" && !options.query) usage();
  const beadsDir = await verifyBeadsDir(options.beadsDir);
  const path = indexPath(beadsDir);

  if (options.command === "reindex") {
    const metadata = await buildIndex(beadsDir, await getBeadsVersion());
    if (options.json) console.log(JSON.stringify({ path, ...metadata }));
    else console.log(`reindexed ${metadata.issue_count} issues: ${path}`);
    return;
  }
  if (options.command === "status") {
    const opened = openIndex(beadsDir);
    const status: Record<string, unknown> = {
      path,
      state: opened ? "ready" : "missing_or_incompatible",
    };
    if (opened) Object.assign(status, opened.metadata);
    opened?.db.close();
    if (options.check) {
      const fresh = await inspectFreshness(beadsDir);
      Object.assign(status, {
        current: fresh.current,
        source_issue_count: fresh.issue_count,
        source_fingerprint: fresh.fingerprint,
      });
    }
    printStatus(status, options.json);
    return;
  }

  let freshness: FreshnessState = "unchecked";
  let opened = openIndex(beadsDir);
  if (!opened) {
    await buildIndex(beadsDir, await getBeadsVersion());
    opened = openIndex(beadsDir);
    if (!opened) {
      throw new Error("index rebuild did not produce a compatible index");
    }
    freshness = "rebuilt";
  }
  if (options.fresh && freshness !== "rebuilt") {
    const fresh = await inspectFreshness(beadsDir);
    if (!fresh.current) {
      opened.db.close();
      await buildIndex(
        beadsDir,
        await getBeadsVersion(),
        exportIssues,
        fresh.issues,
      );
      opened = openIndex(beadsDir);
      if (!opened) {
        throw new Error(
          "fresh index rebuild did not produce a compatible index",
        );
      }
      freshness = "rebuilt";
    } else {
      freshness = "current";
    }
  } else if (options.check && freshness !== "rebuilt") {
    const checked = await inspectFreshness(beadsDir);
    freshness = checked.current ? "current" : "stale";
  }
  try {
    console.error(formatIndexNotice(opened.metadata, freshness));
    printSearch(
      searchIndex(opened.db, options.query, options.limit, options.open),
      options.json,
    );
  } finally {
    opened.db.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `beads-search-full: ${error instanceof Error ? error.message : error}`,
    );
    Deno.exit(1);
  }
}
