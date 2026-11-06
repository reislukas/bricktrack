-- Ein Datensatz steht für einen gesamten Einkauf, auch bei einem Konvolut.
-- Der Gesamtpreis wird in Cent gespeichert, die Menge ist eine ganze Zahl.
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_date TEXT NOT NULL CHECK (length(purchase_date) = 10),
  kind TEXT NOT NULL CHECK (kind IN ('Einzelkauf', 'Konvolut')),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 200),
  price_cents INTEGER NOT NULL CHECK (typeof(price_cents) = 'integer' AND price_cents BETWEEN 0 AND 999999999),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 1000000),
  source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 120),
  owner TEXT NOT NULL CHECK (owner IN ('Jonas', 'Fred', 'Gemeinsam')),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
