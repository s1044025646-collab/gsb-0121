export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS category_mappings (
      id INTEGER PRIMARY KEY CHECK (id > 0),
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS dataset_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      version INTEGER NOT NULL,
      note TEXT,
      content_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      UNIQUE(slug, version)
    );

    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      image_key TEXT NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      UNIQUE(dataset_version_id, image_key)
    );

    CREATE TABLE IF NOT EXISTS dataset_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      category_id INTEGER NOT NULL CHECK (category_id > 0),
      name TEXT NOT NULL,
      UNIQUE(dataset_version_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS gt_boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      image_id INTEGER NOT NULL REFERENCES images(id),
      category_id INTEGER NOT NULL CHECK (category_id > 0),
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_version_id INTEGER NOT NULL REFERENCES model_versions(id),
      dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      image_id INTEGER NOT NULL REFERENCES images(id),
      category_id INTEGER NOT NULL CHECK (category_id > 0),
      score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
      x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pred_lookup
      ON predictions(model_version_id, dataset_version_id);

    CREATE TABLE IF NOT EXISTS protocols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      iou_thresholds TEXT NOT NULL,
      wrong_class_iou REAL NOT NULL,
      duplicate_iou REAL NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      model_version_id INTEGER NOT NULL REFERENCES model_versions(id),
      protocol_id INTEGER NOT NULL REFERENCES protocols(id),
      map REAL NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 1,
      summary_json TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_thresholds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      iou_threshold REAL NOT NULL,
      map REAL NOT NULL,
      total_tp INTEGER NOT NULL,
      total_fp INTEGER NOT NULL,
      total_fn INTEGER NOT NULL,
      per_class_json TEXT NOT NULL,
      UNIQUE(report_id, iou_threshold)
    );

    CREATE TABLE IF NOT EXISTS match_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      iou_threshold REAL NOT NULL,
      image_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      gt_id INTEGER,
      pred_id INTEGER,
      iou REAL NOT NULL,
      tp INTEGER NOT NULL,
      error_kind TEXT,
      score REAL,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_match_report ON match_records(report_id, iou_threshold);
    CREATE INDEX IF NOT EXISTS idx_match_kind ON match_records(report_id, error_kind);
    `,
  },
];
