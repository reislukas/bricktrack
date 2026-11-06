-- Artikel können nach und nach erfasst werden. NULL bedeutet: Kosten noch offen.
-- allocated_cost_cents gilt für die gesamte Menge der Artikelzeile.
CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 200),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 1000000),
  theme TEXT CHECK (theme IS NULL OR theme IN ('Star Wars', 'Ninjago', 'Harry Potter', 'Andere')),
  set_number TEXT CHECK (set_number IS NULL OR length(set_number) BETWEEN 1 AND 20),
  allocated_cost_cents INTEGER CHECK (allocated_cost_cents IS NULL OR
    (typeof(allocated_cost_cents) = 'integer' AND allocated_cost_cents BETWEEN 0 AND 999999999)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX purchase_items_purchase_id ON purchase_items(purchase_id);

-- Die Prüfung läuft innerhalb desselben Schreibvorgangs und schützt so auch
-- vor zwei gleichzeitig eintreffenden Anfragen, die zusammen zu teuer wären.
CREATE TRIGGER purchase_items_cost_insert
BEFORE INSERT ON purchase_items
WHEN COALESCE(NEW.allocated_cost_cents, 0) +
  COALESCE((SELECT SUM(allocated_cost_cents) FROM purchase_items WHERE purchase_id = NEW.purchase_id), 0)
  > (SELECT price_cents FROM purchases WHERE id = NEW.purchase_id)
BEGIN
  SELECT RAISE(ABORT, 'purchase_items_cost_limit');
END;

CREATE TRIGGER purchase_items_cost_update
BEFORE UPDATE ON purchase_items
WHEN COALESCE(NEW.allocated_cost_cents, 0) +
  COALESCE((SELECT SUM(allocated_cost_cents) FROM purchase_items
    WHERE purchase_id = NEW.purchase_id AND id != OLD.id), 0)
  > (SELECT price_cents FROM purchases WHERE id = NEW.purchase_id)
BEGIN
  SELECT RAISE(ABORT, 'purchase_items_cost_limit');
END;

CREATE TRIGGER purchase_price_cost_limit
BEFORE UPDATE OF price_cents ON purchases
WHEN NEW.price_cents < COALESCE((SELECT SUM(allocated_cost_cents) FROM purchase_items WHERE purchase_id = OLD.id), 0)
BEGIN
  SELECT RAISE(ABORT, 'purchase_price_below_item_costs');
END;
