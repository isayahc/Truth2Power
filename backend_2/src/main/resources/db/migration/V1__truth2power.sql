-- Truth2Power backend_2 — Flyway V1 (Phase 2)
-- Read-model tables for the Wave 1 baseline (Sept 2025 review).
-- Source of truth for the import is the repo files: data/maps/hospitals.geojson,
-- data/maps/counties.geojson, data/<id>-*.json, rubrics/css-17-v1.json.
-- The import job (HospitalImportService, profile `import`) populates these tables;
-- it is idempotent on (hospital_id, revision).
--
-- Deliberately NOT here (see plan §5, corrected Nov 11 after mapping the old app):
-- review_items / review_decisions / changes tables. The old app derives review
-- items from audit result files under .audit/live/ and records decisions as
-- append-only JSON files there; the changes feed is computed by running
-- tools/live-audit/changes.py plus pipeline publications from audit.sqlite.
-- Porting those as TiDB tables would diverge from the old app's logic and hide
-- decisions from the old app still running side by side. Phase 2 ports the
-- ReviewController / ChangesController against the same file/compute backing.

CREATE TABLE IF NOT EXISTS counties (
    name        VARCHAR(128) NOT NULL,
    region      VARCHAR(128) NULL,
    PRIMARY KEY (name)
);

-- Dataset-level metadata (the top-level name/attribution of hospitals.geojson),
-- so the DB-backed /api/hospitals can reproduce the file's top level without
-- reading the file. Keys are "hospitals.name" / "hospitals.attribution".
CREATE TABLE IF NOT EXISTS dataset_meta (
    meta_key    VARCHAR(128) NOT NULL,
    meta_value  TEXT         NULL,
    PRIMARY KEY (meta_key)
);

CREATE TABLE IF NOT EXISTS hospitals (
    id                  VARCHAR(16)  NOT NULL,
    name                VARCHAR(255) NOT NULL,
    slug                VARCHAR(255) NOT NULL,
    sort_order          INT          NOT NULL,
    county              VARCHAR(128) NOT NULL,
    address             VARCHAR(255) NULL,
    city                VARCHAR(128) NULL,
    state               CHAR(2)      NOT NULL DEFAULT 'NY',
    zip_code            VARCHAR(16)  NULL,
    latitude            DECIMAL(10,7) NULL,
    longitude           DECIMAL(10,7) NULL,
    grade               CHAR(1)      NULL,
    stars               INT          NULL,
    review_month        CHAR(7)      NULL,
    record_path         VARCHAR(255) NULL,
    assistance_url      VARCHAR(1024) NULL,
    audit_url           VARCHAR(1024) NULL,
    website             VARCHAR(1024) NULL,
    phone               VARCHAR(32)  NULL,
    system_name         VARCHAR(255) NULL,
    source_feature_json TEXT         NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_hospitals_county (county),
    CONSTRAINT fk_hospitals_county FOREIGN KEY (county) REFERENCES counties (name)
);

CREATE TABLE IF NOT EXISTS assessments (
    id                          BIGINT      NOT NULL AUTO_INCREMENT,
    hospital_id                 VARCHAR(16) NOT NULL,
    revision                    CHAR(64)    NOT NULL,
    grade                       CHAR(1)     NULL,
    stars                       INT         NULL,
    automatic_fail              BOOLEAN     NOT NULL DEFAULT FALSE,
    noncompliant_count          INT         NULL,
    noncompliant_count_derived  INT         NULL,
    assessed_at                 DATE        NULL,
    source_row                  JSON        NOT NULL,
    created_at                  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_assessments_hospital_revision (hospital_id, revision),
    CONSTRAINT fk_assessments_hospital FOREIGN KEY (hospital_id) REFERENCES hospitals (id)
);

CREATE TABLE IF NOT EXISTS measure_results (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    assessment_id   BIGINT       NOT NULL,
    measure_id      VARCHAR(128) NOT NULL,
    css_column      CHAR(2)      NULL,
    status          VARCHAR(16)  NOT NULL,
    evidence_ref    VARCHAR(1024) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_measure_results (assessment_id, measure_id),
    CONSTRAINT fk_measure_results_assessment FOREIGN KEY (assessment_id) REFERENCES assessments (id)
);

CREATE TABLE IF NOT EXISTS audit_runs (
    id          VARCHAR(64)  NOT NULL,
    hospital_id VARCHAR(16)  NULL,
    kind        VARCHAR(64)  NULL,
    status      VARCHAR(32)  NULL,
    started_at  TIMESTAMP    NULL,
    finished_at TIMESTAMP    NULL,
    log_path    VARCHAR(1024) NULL,
    PRIMARY KEY (id),
    INDEX idx_audit_runs_hospital (hospital_id)
);
