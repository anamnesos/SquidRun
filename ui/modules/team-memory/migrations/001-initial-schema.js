/**
 * Team Memory schema migration v1.
 * Fresh install baseline for Claim Graph + Layer 3/4/5 tables.
 */

const SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  statement TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('fact', 'decision', 'hypothesis', 'negative')),
  owner TEXT NOT NULL,
  confidence REAL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  status TEXT DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'contested', 'pending_proof', 'deprecated')),
  supersedes TEXT REFERENCES claims(id),
  session TEXT,
  ttl_hours INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_owner ON claims(owner);
CREATE INDEX IF NOT EXISTS idx_claims_type ON claims(claim_type);
CREATE INDEX IF NOT EXISTS idx_claims_session ON claims(session);
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at);

CREATE TABLE IF NOT EXISTS claim_scopes (
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  PRIMARY KEY (claim_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_scopes_scope ON claim_scopes(scope);

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_ref TEXT NOT NULL,
  added_by TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'caused_by')),
  weight REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (claim_id, evidence_ref)
);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_ref ON claim_evidence(evidence_ref);

CREATE TABLE IF NOT EXISTS claim_status_history (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  reason TEXT,
  changed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_claim ON claim_status_history(claim_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  decided_by TEXT NOT NULL,
  context TEXT,
  rationale TEXT,
  outcome TEXT CHECK (outcome IN ('success', 'partial', 'failure', 'unknown')),
  outcome_notes TEXT,
  created_at INTEGER NOT NULL,
  session TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisions_claim ON decisions(claim_id);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session);

CREATE TABLE IF NOT EXISTS decision_alternatives (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  alternative_id TEXT NOT NULL REFERENCES claims(id),
  rejection_reason TEXT,
  PRIMARY KEY (decision_id, alternative_id)
);

CREATE TABLE IF NOT EXISTS consensus (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  position TEXT NOT NULL CHECK (position IN ('support', 'challenge', 'abstain')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(claim_id, agent)
);

CREATE INDEX IF NOT EXISTS idx_consensus_claim ON consensus(claim_id);

CREATE TABLE IF NOT EXISTS belief_snapshots (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  beliefs TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON belief_snapshots(agent);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON belief_snapshots(session);

CREATE TABLE IF NOT EXISTS belief_contradictions (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES belief_snapshots(id) ON DELETE CASCADE,
  claim_a TEXT NOT NULL REFERENCES claims(id),
  claim_b TEXT NOT NULL REFERENCES claims(id),
  agent TEXT NOT NULL,
  session TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_contradictions_agent ON belief_contradictions(agent);
CREATE INDEX IF NOT EXISTS idx_contradictions_session ON belief_contradictions(session);
CREATE INDEX IF NOT EXISTS idx_contradictions_claim_a ON belief_contradictions(claim_a);
CREATE INDEX IF NOT EXISTS idx_contradictions_claim_b ON belief_contradictions(claim_b);

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('handoff_loop', 'escalation_spiral', 'stall', 'contradiction_cluster')),
  agents TEXT NOT NULL,
  scope TEXT,
  frequency INTEGER DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  risk_score REAL CHECK (risk_score BETWEEN 0.0 AND 1.0),
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_patterns_risk ON patterns(risk_score);

CREATE TABLE IF NOT EXISTS guards (
  id TEXT PRIMARY KEY,
  trigger_condition TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('warn', 'escalate')),
  source_claim TEXT REFERENCES claims(id),
  source_pattern TEXT REFERENCES patterns(id),
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_guards_active ON guards(active) WHERE active = 1;
`;

module.exports = {
  version: 1,
  description: 'Claim graph baseline schema (v1)',
  sql: SQL,
};
