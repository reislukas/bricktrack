// Ein Artikel gehört immer zu genau einem Einkauf. Seine Herkunft ist nicht editierbar.
function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function validId(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validateItem(data) {
  const errors = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: { form: 'Bitte einen Artikel als JSON-Objekt senden.' } };
  }
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description || description.length > 200) errors.description = 'Beschreibung: 1 bis 200 Zeichen.';
  if (!Number.isInteger(data.quantity) || data.quantity < 1 || data.quantity > 1000000) {
    errors.quantity = 'Die Menge muss eine ganze Zahl von 1 bis 1.000.000 sein.';
  }
  const theme = data.theme === '' || data.theme == null ? null : data.theme;
  if (theme !== null && !['Star Wars', 'Ninjago', 'Harry Potter', 'Andere'].includes(theme)) {
    errors.theme = 'Bitte eine angebotene Themenwelt auswählen.';
  }
  let setNumber = null;
  if (data.set_number != null && data.set_number !== '') {
    if (typeof data.set_number !== 'string' || !/^\d{1,10}(-\d{1,3})?$/.test(data.set_number.trim())) {
      errors.set_number = 'Setnummer: Ziffern, optional mit Variantenkennung, z. B. 75367 oder 75367-1.';
    } else setNumber = data.set_number.trim();
  }

  let cost = null;
  // Ein leeres Feld bleibt NULL. Eine ausdrücklich eingegebene 0 bleibt 0 Cent.
  if (data.allocated_cost != null && data.allocated_cost !== '') {
    if (typeof data.allocated_cost !== 'string' || !/^\d{1,7}([.,]\d{1,2})?$/.test(data.allocated_cost.trim())) {
      errors.allocated_cost = 'Kosten: 0 bis 9.999.999,99 € mit höchstens zwei Nachkommastellen oder leer lassen.';
    } else {
      const [euros, cents = ''] = data.allocated_cost.trim().replace(',', '.').split('.');
      cost = Number(euros) * 100 + Number(cents.padEnd(2, '0'));
    }
  }
  return { errors, item: { description, quantity: data.quantity, theme, setNumber, cost } };
}

// Für die geplante Verkaufsverwaltung gilt: order_items.purchase_item_id verweist
// mit ON DELETE RESTRICT auf den Bestandsartikel. Die Tabelle wird hier nicht angelegt.
async function hasLinkedSales(db, itemId) {
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_items'").first();
  if (!table) return false;
  return Boolean(await db.prepare('SELECT 1 FROM order_items WHERE purchase_item_id = ? LIMIT 1').bind(itemId).first());
}

export async function handlePurchaseItems(request, env, purchaseIdText, itemIdText) {
  const hasItemId = itemIdText !== undefined;
  const allowed = hasItemId ? ['PUT', 'DELETE'] : ['GET', 'POST'];
  if (!allowed.includes(request.method)) return json({ error: 'Methode nicht erlaubt.' }, 405, { Allow: allowed.join(', ') });
  if (!validId(purchaseIdText) || (hasItemId && !validId(itemIdText))) {
    return json({ error: 'Die Kauf-ID oder Artikel-ID ist ungültig.' }, 400);
  }
  const purchaseId = Number(purchaseIdText);
  const itemId = hasItemId ? Number(itemIdText) : null;

  try {
    if (request.method !== 'GET') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== new URL(request.url).origin) return json({ error: 'Anfrage von einer anderen Webseite abgewiesen.' }, 403);
    }
    const purchase = await env.DB.prepare('SELECT * FROM purchases WHERE id = ?').bind(purchaseId).first();
    if (!purchase) return json({ error: 'Dieser Einkauf wurde nicht gefunden.' }, 404);

    if (request.method === 'GET') {
      const { results: items } = await env.DB.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').bind(purchaseId).all();
      const allocated = items.reduce((sum, item) => sum + (item.allocated_cost_cents ?? 0), 0);
      return json({ purchase, items, allocated_cost_cents: allocated,
        unallocated_cost_cents: purchase.price_cents - allocated,
        unassigned_item_count: items.filter(item => item.allocated_cost_cents === null).length });
    }

    if (hasItemId) {
      const existing = await env.DB.prepare('SELECT id FROM purchase_items WHERE id = ? AND purchase_id = ?').bind(itemId, purchaseId).first();
      if (!existing) return json({ error: 'Dieser Artikel gehört nicht zu diesem Einkauf oder wurde nicht gefunden.' }, 404);
      if (await hasLinkedSales(env.DB, itemId)) return json({ error: 'Dieser Artikel ist mit Verkäufen verknüpft und kann nicht geändert oder gelöscht werden.' }, 409);
    }
    if (request.method === 'DELETE') {
      const deleted = await env.DB.prepare('DELETE FROM purchase_items WHERE id = ? AND purchase_id = ? RETURNING id').bind(itemId, purchaseId).first();
      if (!deleted) return json({ error: 'Artikel nicht gefunden.' }, 404);
      return json({ deleted: true, id: deleted.id });
    }
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: 'Bitte JSON senden (Content-Type: application/json).' }, 415);
    }
    let data;
    try { data = await request.json(); }
    catch { return json({ error: 'Die Anfrage enthält kein gültiges JSON.' }, 400); }
    const { errors, item } = validateItem(data);
    if (Object.keys(errors).length) return json({ error: 'Bitte die Artikeleingaben prüfen.', errors }, 400);

    let saved;
    if (hasItemId) {
      saved = await env.DB.prepare(`UPDATE purchase_items
        SET description = ?, quantity = ?, theme = ?, set_number = ?, allocated_cost_cents = ?
        WHERE id = ? AND purchase_id = ? RETURNING *`)
        .bind(item.description, item.quantity, item.theme, item.setNumber, item.cost, itemId, purchaseId).first();
    } else {
      saved = await env.DB.prepare(`INSERT INTO purchase_items
        (purchase_id, description, quantity, theme, set_number, allocated_cost_cents)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
        .bind(purchaseId, item.description, item.quantity, item.theme, item.setNumber, item.cost).first();
    }
    if (!saved) return json({ error: 'Artikel nicht gefunden.' }, 404);
    return json({ item: saved }, hasItemId ? 200 : 201);
  } catch (error) {
    if (/purchase_items_cost_limit/.test(error.message || '')) {
      return json({ error: 'Die zugeordneten Artikelkosten würden den gesamten Einkaufspreis überschreiten.' }, 409);
    }
    if (/FOREIGN KEY constraint failed/i.test(error.message || '')) {
      return json({ error: 'Der Artikel ist noch verknüpft und kann nicht gelöscht werden.' }, 409);
    }
    console.error('Bestandsartikel:', error);
    return json({ error: 'Bestandsartikel konnten nicht verarbeitet werden. Bitte lokale Migrationen und Server prüfen.' }, 500);
  }
}
