import { DatabaseSync } from "node:sqlite";
import {
  assertBeadsDirMatch,
  buildIndex,
  fingerprintIssues,
  formatIndexNotice,
  formatSearchJson,
  ftsQuote,
  hasCompatibleSchema,
  type IndexedIssue,
  normalizeForProse,
  normalizeIssue,
  parseArgs,
  parseWhereJson,
  proseTerms,
  searchIndex,
  trigramTerms,
} from "./scripts/search.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("normalizes optional fields and aggregates comments", () => {
  const issue = normalizeIssue({
    _type: "issue",
    id: "x-1",
    title: "An issue",
    comments: [{ text: "first" }, { text: null }, { text: "second" }],
    priority: "2",
    issue_type: "task",
  });
  if (!issue) throw new Error("issue was unexpectedly ignored");
  if (issue.comments !== "first\nsecond") throw new Error(issue.comments);
  if (issue.design !== "" || issue.acceptance_criteria !== "") {
    throw new Error("missing fields must normalize to empty strings");
  }
  if (issue.priority !== 2) throw new Error(`priority: ${issue.priority}`);
  if (normalizeIssue({ _type: "memory", id: "m-1" }) !== null) {
    throw new Error("non-issue records must be ignored");
  }
  if (normalizeIssue({ _schema: 1 }) !== null) {
    throw new Error("schema headers must be ignored");
  }
});

Deno.test("query tokenization keeps prose and identifier paths separate", () => {
  const prose = proseTerms("PR#330 ipc_policy R4.2");
  if (
    JSON.stringify(prose) !==
      JSON.stringify(["PR", "330", "ipc", "policy", "R4", "2"])
  ) {
    throw new Error(`unexpected prose terms: ${prose.join(",")}`);
  }
  const trigrams = trigramTerms("PR#330 ipc_policy R4.2 q2");
  if (
    JSON.stringify(trigrams) !==
      JSON.stringify(["PR#330", "ipc_policy", "R4.2"])
  ) {
    throw new Error(`unexpected trigram terms: ${trigrams.join(",")}`);
  }
  if (ftsQuote('arf::"ipc') !== '"arf::""ipc"') {
    throw new Error("FTS quote is unsafe");
  }
});

Deno.test("where JSON parser accepts top-level and envelope shapes", () => {
  assert(
    parseWhereJson('{"path":"/tmp/beads"}') === "/tmp/beads",
    "top-level where JSON was not parsed",
  );
  assert(
    parseWhereJson('{"schema_version":1,"data":{"path":"/tmp/shared"}}') ===
      "/tmp/shared",
    "enveloped where JSON was not parsed",
  );
  let rejected = false;
  try {
    parseWhereJson('{"data":{"not_path":"/tmp/nope"}}');
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("no path");
  }
  assert(rejected, "invalid where JSON was accepted");
});

Deno.test("-- stops option parsing for literal flag-like query text", () => {
  const options = parseArgs(["search", "--", "--check", "literal"]);
  assert(options.command === "search", "command was parsed incorrectly");
  assert(options.query === "--check literal", "literal query was changed");
  assert(!options.check, "literal --check was reinterpreted as an option");
});

Deno.test("fingerprint is independent of export order", async () => {
  const first = normalizeIssue({ _type: "issue", id: "a", title: "A" });
  const second = normalizeIssue({ _type: "issue", id: "b", title: "B" });
  if (!first || !second) throw new Error("normalization failed");
  const left = await fingerprintIssues([first, second]);
  const right = await fingerprintIssues([second, first]);
  if (left !== right) throw new Error("fingerprint depends on export order");
});

Deno.test("prose normalization preserves punctuation and separates mixed scripts", () => {
  assert(
    normalizeForProse("r-polars") === "r-polars",
    "punctuation was rewritten",
  );
  assert(
    normalizeForProse("artifact優先") === "artifact 優先",
    "mixed-script boundary was not separated",
  );
});

Deno.test("contentless FTS5 indexes retain matches without body text", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE prose USING fts5(title, body, content='')");
    db.prepare("INSERT INTO prose(rowid, title, body) VALUES (?, ?, ?)").run(
      1,
      "needle",
      "a body",
    );
    const row = db.prepare(
      "SELECT rowid, title, bm25(prose) AS score FROM prose WHERE prose MATCH ?",
    ).get('"needle"') as
      | { rowid: number; title: unknown; score: number }
      | undefined;
    if (
      !row || Number(row.rowid) !== 1 || row.title !== null ||
      typeof row.score !== "number"
    ) {
      throw new Error("contentless FTS5 behavior changed");
    }
  } finally {
    db.close();
  }
});

Deno.test("trigram all-terms evidence outranks partial recall", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE documents (
        rowid INTEGER PRIMARY KEY, issue_id TEXT, title TEXT, status TEXT,
        priority INTEGER, issue_type TEXT, updated_at TEXT
      );
      CREATE VIRTUAL TABLE prose_fts USING fts5(
        title, description, design, acceptance_criteria, notes, close_reason,
        comments, content='', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE trigram_fts USING fts5(
        title, description, design, acceptance_criteria, notes, close_reason,
        comments, content='', tokenize='trigram'
      );
    `);
    const documents = [
      [1, "exact", "ready artifact優先"],
      [2, "partial", "ready artifact"],
    ];
    const insertDocument = db.prepare(
      "INSERT INTO documents VALUES (?, ?, ?, 'open', 2, 'task', '2026-01-01T00:00:00Z')",
    );
    const insertProse = db.prepare(
      "INSERT INTO prose_fts(rowid, title, description, design, acceptance_criteria, notes, close_reason, comments) VALUES (?, ?, '', '', '', '', '', '')",
    );
    const insertTrigram = db.prepare(
      "INSERT INTO trigram_fts(rowid, title, description, design, acceptance_criteria, notes, close_reason, comments) VALUES (?, ?, '', '', '', '', '', '')",
    );
    for (const [rowid, id, title] of documents) {
      insertDocument.run(rowid, id, title);
      insertProse.run(rowid, normalizeForProse(String(title)));
      insertTrigram.run(rowid, String(title));
    }
    const results = searchIndex(db, "ready artifact優先", 2, false);
    assert(
      results[0]?.issue_id === "exact",
      "exact trigram match was not first",
    );
    assert(
      results[0]?.path.includes("trigram"),
      "result did not use trigram evidence",
    );
  } finally {
    db.close();
  }
});

Deno.test("mixed-script boundary evidence makes PR#330 searchable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE documents (
        rowid INTEGER PRIMARY KEY, issue_id TEXT, title TEXT, status TEXT,
        priority INTEGER, issue_type TEXT, updated_at TEXT
      );
      CREATE VIRTUAL TABLE prose_fts USING fts5(
        title, description, design, acceptance_criteria, notes, close_reason,
        comments, content='', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE trigram_fts USING fts5(
        title, description, design, acceptance_criteria, notes, close_reason,
        comments, content='', tokenize='trigram'
      );
    `);
    const raw = "PR #330最新CI確認";
    assert(
      normalizeForProse(raw) === "PR #330 最新 CI 確認",
      "mixed-script boundary normalization changed unexpectedly",
    );
    db.prepare("INSERT INTO documents VALUES (?, ?, ?, 'open', 2, 'task', ?)")
      .run(
        1,
        "mixed-script",
        raw,
        "2026-01-01T00:00:00Z",
      );
    db.prepare(
      "INSERT INTO prose_fts(rowid, title, description, design, acceptance_criteria, notes, close_reason, comments) VALUES (?, ?, '', '', '', '', '', '')",
    ).run(1, normalizeForProse(raw));
    db.prepare(
      "INSERT INTO trigram_fts(rowid, title, description, design, acceptance_criteria, notes, close_reason, comments) VALUES (?, ?, '', '', '', '', '', '')",
    ).run(1, raw);
    const results = searchIndex(db, "PR#330", 1, false);
    assert(
      results[0]?.issue_id === "mixed-script",
      "PR#330 did not match mixed-script evidence",
    );
    assert(
      results[0]?.title === raw,
      "compact result did not retain raw title",
    );
  } finally {
    db.close();
  }
});

Deno.test("path validator rejects a different resolved directory", () => {
  assertBeadsDirMatch("/tmp/effective-beads", "/tmp/effective-beads");
  let rejected = false;
  try {
    assertBeadsDirMatch("/tmp/other-beads", "/tmp/effective-beads");
  } catch (error) {
    rejected = error instanceof Error &&
      error.message.includes("does not match");
  }
  assert(rejected, "mismatching beads directory was accepted");
});

Deno.test("failed rebuild preserves the previous complete index", async () => {
  const dir = await Deno.makeTempDir({ prefix: "beads-search-full-" });
  try {
    const oldIssue = normalizeIssue({
      _type: "issue",
      id: "stable",
      title: "stable title",
      status: "open",
      issue_type: "task",
    });
    assert(oldIssue, "fixture normalization failed");
    const successfulExport = async (
      onIssue: (issue: IndexedIssue) => void,
    ) => onIssue(oldIssue);
    await buildIndex(dir, "test", successfulExport);
    const failedExport = async (
      onIssue: (issue: IndexedIssue) => void,
    ) => {
      onIssue(oldIssue);
      throw new Error("simulated export failure");
    };
    let failed = false;
    try {
      await buildIndex(dir, "test", failedExport);
    } catch (error) {
      failed = error instanceof Error && error.message.includes("simulated");
    }
    assert(failed, "failed export did not fail the rebuild");
    const db = new DatabaseSync(`${dir}/search-index.db`, { readOnly: true });
    try {
      const complete = db.prepare(
        "SELECT value FROM index_meta WHERE key = 'complete'",
      ).get() as { value?: string } | undefined;
      const title = db.prepare("SELECT title FROM documents WHERE issue_id = ?")
        .get(
          "stable",
        ) as { title?: string } | undefined;
      assert(
        complete?.value === "true",
        "previous index is no longer complete",
      );
      assert(
        title?.title === "stable title",
        "previous document was not preserved",
      );
      const results = searchIndex(db, "stable", 1, false);
      assert(
        results[0]?.issue_id === "stable",
        "previous FTS index was not preserved",
      );
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("index metadata fingerprint distinguishes current and stale data", async () => {
  const dir = await Deno.makeTempDir({ prefix: "beads-search-full-" });
  try {
    const issue = normalizeIssue({
      _type: "issue",
      id: "fingerprint",
      title: "before",
    });
    assert(issue, "fixture normalization failed");
    const metadata = await buildIndex(
      dir,
      "test",
      async (onIssue) => onIssue(issue),
    );
    assert(metadata.complete === "true", "index was not marked complete");
    assert(
      metadata.fingerprint === await fingerprintIssues([issue]),
      "stored fingerprint is incorrect",
    );
    const changed = { ...issue, title: "after" };
    assert(
      metadata.fingerprint !== await fingerprintIssues([changed]),
      "stale data was not detected",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rebuild can consume a freshness snapshot without exporting again", async () => {
  const dir = await Deno.makeTempDir({ prefix: "beads-search-full-" });
  try {
    const issue = normalizeIssue({
      _type: "issue",
      id: "snapshot",
      title: "cached",
    });
    assert(issue, "fixture normalization failed");
    let runnerCalled = false;
    const metadata = await buildIndex(
      dir,
      "test",
      async () => {
        runnerCalled = true;
        throw new Error("snapshot rebuild unexpectedly exported");
      },
      [issue],
    );
    assert(!runnerCalled, "snapshot rebuild invoked bd export");
    assert(metadata.issue_count === "1", "snapshot issue was not indexed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("index notice reports freshness without changing result output", () => {
  const metadata = {
    built_at: "2026-01-02T03:04:05Z",
    issue_count: "42",
  };
  const unchecked = formatIndexNotice(metadata, "unchecked");
  assert(unchecked.includes("freshness=unchecked"), unchecked);
  assert(unchecked.includes("built_at=2026-01-02T03:04:05Z"), unchecked);
  assert(unchecked.includes("issues=42"), unchecked);

  const stale = formatIndexNotice(metadata, "stale");
  assert(stale.includes("freshness=stale"), stale);
  assert(stale.includes("action=use --fresh or reindex"), stale);
});

Deno.test("JSON results remain parseable independently of stderr notices", () => {
  const json = formatSearchJson([{
    issue_id: "compact",
    title: "A result",
    status: "open",
    priority: 2,
    issue_type: "task",
    updated_at: "2026-01-01T00:00:00Z",
    path: "prose",
    score: 0.01,
  }]);
  const parsed = JSON.parse(json) as Array<{ rank: number; issue_id: string }>;
  assert(parsed.length === 1 && parsed[0].rank === 1, "JSON result is invalid");
  assert(!json.includes("freshness="), "stderr notice leaked into JSON output");
});

Deno.test("incomplete or incompatible metadata is rejected", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO index_meta VALUES (?, ?)").run(
      "schema_version",
      "3",
    );
    assert(!hasCompatibleSchema(db), "incomplete metadata was accepted");
    db.prepare("INSERT INTO index_meta VALUES (?, ?)").run("complete", "true");
    assert(hasCompatibleSchema(db), "complete metadata was rejected");
    db.prepare("UPDATE index_meta SET value = ? WHERE key = ?").run(
      "4",
      "schema_version",
    );
    assert(!hasCompatibleSchema(db), "incompatible schema was accepted");
  } finally {
    db.close();
  }
});

function makeStatusFixture(token: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
      CREATE TABLE documents (
        rowid INTEGER PRIMARY KEY, issue_id TEXT, title TEXT, status TEXT,
        priority INTEGER, issue_type TEXT, updated_at TEXT
      );
      CREATE VIRTUAL TABLE prose_fts USING fts5(
        title, description, design, acceptance_criteria, notes, close_reason,
        comments, content='', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE trigram_fts USING fts5(
        title, description, design, acceptance_criteria, notes, close_reason,
        comments, content='', tokenize='trigram'
      );
    `);
  const insertDocument = db.prepare(
    "INSERT INTO documents VALUES (?, ?, ?, ?, 2, 'task', '2026-01-01T00:00:00Z')",
  );
  const insertProse = db.prepare(
    "INSERT INTO prose_fts(rowid, title, description, design, acceptance_criteria, notes, close_reason, comments) VALUES (?, ?, '', '', '', '', '', '')",
  );
  const insertTrigram = db.prepare(
    "INSERT INTO trigram_fts(rowid, title, description, design, acceptance_criteria, notes, close_reason, comments) VALUES (?, ?, '', '', '', '', '', '')",
  );
  for (let rowid = 1; rowid <= 260; rowid++) {
    insertDocument.run(rowid, `closed-${rowid}`, token, "closed");
    insertProse.run(rowid, token);
    insertTrigram.run(rowid, token);
  }
  insertDocument.run(1000, "open-target", token, "open");
  insertProse.run(1000, token);
  insertTrigram.run(1000, token);
  return db;
}

Deno.test("open search filters closed matches before prose FTS cutoff", () => {
  const db = makeStatusFixture("q2");
  try {
    const ordinary = searchIndex(db, "q2", 1, false);
    assert(
      ordinary[0]?.status === "closed",
      "ordinary prose search should include closed matches",
    );
    const openOnly = searchIndex(db, "q2", 1, true);
    assert(
      openOnly[0]?.issue_id === "open-target",
      "open prose search lost a match below the FTS cutoff",
    );
  } finally {
    db.close();
  }
});

Deno.test("open search filters closed matches before trigram FTS cutoff", () => {
  const db = makeStatusFixture(":::");
  try {
    const ordinary = searchIndex(db, ":::", 1, false);
    assert(
      ordinary[0]?.status === "closed",
      "ordinary trigram search should include closed matches",
    );
    const openOnly = searchIndex(db, ":::", 1, true);
    assert(
      openOnly[0]?.issue_id === "open-target",
      "open trigram search lost a match below the FTS cutoff",
    );
  } finally {
    db.close();
  }
});
