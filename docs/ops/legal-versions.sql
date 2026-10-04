-- Published versions of Biblicana's Terms of Service and Privacy Policy.
--
-- The source of each version is a markdown file in blueberean-site
-- (legal/<document>/v<N>.md); a row here is the hash-checked copy the bot reads
-- to decide whether a user must re-acknowledge (src/utils/legalVersions.js).
-- Rows are inserted only by `pnpm run legal:publish`, which refuses unless the
-- live site already serves the exact text. Never insert by hand.
--
-- Append-only: a published version is a record of what users were shown.
--
-- Applied by Kenneth's session (2026-10-03) to stephen-dev, then main, as
-- biblicana_owner. Idempotent.

CREATE TABLE IF NOT EXISTS legal_document_versions (
    document     text        NOT NULL CHECK (document IN ('terms', 'privacy')),
    version      integer     NOT NULL CHECK (version > 0),
    effective_at timestamptz NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    change_level text        NOT NULL CHECK (change_level IN ('editorial', 'notice', 'material')),
    summary      text        NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 400),
    body_md      text        NOT NULL,
    body_sha256  text        NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (document, version)
);

CREATE OR REPLACE FUNCTION legal_versions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'legal_document_versions is append-only (% refused)', TG_OP;
END $$;

DROP TRIGGER IF EXISTS legal_versions_no_update_delete ON legal_document_versions;
CREATE TRIGGER legal_versions_no_update_delete
    BEFORE UPDATE OR DELETE ON legal_document_versions
    FOR EACH ROW EXECUTE FUNCTION legal_versions_append_only();

-- TRUNCATE bypasses row triggers, so it gets its own statement trigger.
DROP TRIGGER IF EXISTS legal_versions_no_truncate ON legal_document_versions;
CREATE TRIGGER legal_versions_no_truncate
    BEFORE TRUNCATE ON legal_document_versions
    FOR EACH STATEMENT EXECUTE FUNCTION legal_versions_append_only();
