/**
 * SQLite backend reporting.
 *
 * node:sqlite (Node's built-in real SQLite) is the sole backend. Pin that
 * DatabaseConnection / CodeGraph report it and come up in WAL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { createDatabase } from '../src/db/sqlite-adapter';
import { getCurrentVersion, runMigrations, CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { CodeGraph } from '../src';

describe('DatabaseConnection — backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the node-sqlite backend in WAL for an initialized DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    expect(conn.getBackend()).toBe('node-sqlite');
    expect(conn.getJournalMode()).toBe('wal');
    conn.close();
  });

  it('CodeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(cg.getBackend()).toBe('node-sqlite');
    } finally {
      cg.destroy();
    }
  });
});

describe('C/C++ semantic provenance schema', () => {
  let dir: string;
  let conn: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-db-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'graph.db'));
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades older schema records and cascades config, node and edge memberships', () => {
    const raw = conn.getDb();
    raw.prepare('INSERT OR IGNORE INTO schema_versions VALUES (9, ?, ?)').run(Date.now(), 'legacy v9');
    raw.prepare('DELETE FROM schema_versions WHERE version > 9').run();
    runMigrations(raw, getCurrentVersion(raw));
    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
    // A replay over the current schema must not fail on duplicate columns or tables.
    raw.prepare('DELETE FROM schema_versions WHERE version > 9').run();
    runMigrations(raw, getCurrentVersion(raw));
    const queries = new QueryBuilder(raw);
    queries.insertNode({ id: 'f', kind: 'function', name: 'f', qualifiedName: 'f',
      filePath: 'f.c', language: 'c', startLine: 1, endLine: 2,
      startColumn: 0, endColumn: 1, updatedAt: 1 });
    queries.insertNode({ id: 'g', kind: 'function', name: 'g', qualifiedName: 'g',
      filePath: 'f.c', language: 'c', startLine: 3, endLine: 4,
      startColumn: 0, endColumn: 1, updatedAt: 1 });
    queries.insertEdge({ source: 'f', target: 'g', kind: 'calls', line: 1, provenance: 'clangd' });
    const edge = raw.prepare('SELECT id FROM edges LIMIT 1').get() as { id: number };
    raw.prepare('INSERT INTO semantic_configs (id,label,flags_hash,authority,updated_at) VALUES (?,?,?,?,?)')
      .run('a', 'a', 'hash', 'authoritative', 1);
    raw.prepare('INSERT INTO semantic_node_configs (node_id,config_id) VALUES (?,?)').run('f', 'a');
    raw.prepare('INSERT INTO semantic_edge_configs (edge_id,config_id) VALUES (?,?)').run(edge.id, 'a');
    raw.prepare('DELETE FROM semantic_configs WHERE id = ?').run('a');
    expect(raw.prepare('SELECT * FROM semantic_node_configs').all()).toHaveLength(0);
    expect(raw.prepare('SELECT * FROM semantic_edge_configs').all()).toHaveLength(0);
  });

  it('adds semantic origin and cascade-safe provenance tables to an actual v9 database', () => {
    const legacy = createDatabase(path.join(dir, 'legacy.db')).db;
    try {
      legacy.pragma('foreign_keys = ON');
      legacy.exec(`
        CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
        INSERT INTO schema_versions VALUES (9, 0, 'legacy');
        CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT);
        CREATE TABLE edges (id INTEGER PRIMARY KEY, source TEXT, target TEXT, provenance TEXT,
          FOREIGN KEY(source) REFERENCES nodes(id) ON DELETE CASCADE,
          FOREIGN KEY(target) REFERENCES nodes(id) ON DELETE CASCADE);
        INSERT INTO nodes VALUES ('old', 'function', 'old', 'old.c');
      `);
      runMigrations(legacy, 9);
      expect((legacy.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).
        map(row => row.name)).toContain('semantic_origin');
      expect(legacy.prepare('SELECT id,semantic_origin FROM nodes').all()).toEqual([{ id: 'old', semantic_origin: null }]);
      legacy.prepare('INSERT INTO semantic_configs (id,label,flags_hash,authority,updated_at) VALUES (?,?,?,?,?)')
        .run('old-config', 'old-config', 'hash', 'authoritative', 1);
      legacy.prepare('INSERT INTO semantic_node_configs (node_id,config_id) VALUES (?,?)').run('old', 'old-config');
      legacy.prepare('DELETE FROM nodes WHERE id = ?').run('old');
      expect(legacy.prepare('SELECT * FROM semantic_node_configs').all()).toEqual([]);
    } finally {
      legacy.close();
    }
  });
});
