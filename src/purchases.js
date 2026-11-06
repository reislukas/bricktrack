// API für lokale Einkäufe. SQL-Parameter werden separat gebunden, nie eingesetzt.
const owners = ['Jonas', 'Fred', 'Gemeinsam'];
const kinds = ['Einzelkauf', 'Konvolut'];

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function validatePurchase(data) {
  const errors = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: { form: 'Bitte einen Einkauf als JSON-Objekt senden.' } };
  }

  // Strings werden gekürzt; andere Datentypen werden nicht stillschweigend umgewandelt.
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const source = typeof data.source === 'string' ? data.source.trim() : '';
  const notes = typeof data.notes === 'string' ? data.notes.trim() : '';
  if (!description || description.length > 200) errors.description = 'Bitte 1 bis 200 Zeichen eingeben.';
  if (!source || source.length > 120) errors.source = 'Bitte eine Bezugsquelle mit 1 bis 120 Zeichen eingeben.';
  if ((data.notes !== undefined && typeof data.notes !== 'string') || notes.length > 2000) {
    errors.notes = 'Notizen dürfen höchstens 2000 Zeichen enthalten.';
  }
  if (!owners.includes(data.owner)) errors.owner = 'Bitte Jonas, Fred oder Gemeinsam auswählen.';
  if (!kinds.includes(data.kind)) errors.kind = 'Bitte Einzelkauf oder Konvolut auswählen.';
  if (!Number.isInteger(data.quantity) || data.quantity < 1 || data.quantity > 1000000) {
    errors.quantity = 'Die Menge muss eine ganze Zahl zwischen 1 und 1.000.000 sein.';
  }

  // Rückvergleich verhindert ungültige Kalendertage wie den 31. Februar.
  const date = data.purchase_date;
  const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && date >= '1900-01-01'
    && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!validDate) errors.purchase_date = 'Bitte ein gültiges Einkaufsdatum ab 1900 eingeben.';

  // Preis als Dezimal-String: z. B. "12,50" oder "12.50". Kein Rechnen mit Kommazahlen.
  let priceCents;
  if (typeof data.price !== 'string' || !/^\d{1,7}([.,]\d{1,2})?$/.test(data.price.trim())) {
    errors.price = 'Bitte einen Preis von 0 bis 9.999.999,99 € mit höchstens zwei Nachkommastellen eingeben.';
  } else {
    const [euros, cents = ''] = data.price.trim().replace(',', '.').split('.');
    priceCents = Number(euros) * 100 + Number(cents.padEnd(2, '0'));
  }

  return {
    errors,
    purchase: { purchase_date: date, kind: data.kind, description, price_cents: priceCents,
      quantity: data.quantity, source, owner: data.owner, notes },
  };
}

export async function handlePurchases(request, env) {
  const pathname = new URL(request.url).pathname;
  const updateMatch = pathname.match(/^\/api\/purchases\/(\d+)$/);
  const isUpdate = Boolean(updateMatch);
  const purchaseId = isUpdate ? Number(updateMatch[1]) : null;
  const allowedMethods = isUpdate ? ['PUT', 'DELETE'] : ['GET', 'POST'];

  if (!allowedMethods.includes(request.method)) {
    return json({ error: 'Methode nicht erlaubt.' }, 405, { Allow: allowedMethods.join(', ') });
  }
  if (isUpdate && (!Number.isSafeInteger(purchaseId) || purchaseId < 1)) {
    return json({ error: 'Die Kauf-ID ist ungültig.' }, 400);
  }

  try {
    if (request.method === 'DELETE') {
      // Löschaktionen dürfen nur von dieser BrickTrack-Seite kommen.
      const origin = request.headers.get('Origin');
      if (origin && origin !== new URL(request.url).origin) {
        return json({ error: 'Diese Anfrage stammt von einer anderen Webseite.' }, 403);
      }

      try {
        const item = await env.DB.prepare('SELECT id FROM purchase_items WHERE purchase_id = ? LIMIT 1').bind(purchaseId).first();
        if (item) return json({ error: 'Dieser Einkauf enthält noch Bestandsartikel. Entferne zuerst die zugeordneten Artikel.' }, 409);
        const deletedPurchase = await env.DB.prepare(
          'DELETE FROM purchases WHERE id = ? RETURNING id'
        ).bind(purchaseId).first();
        if (!deletedPurchase) return json({ error: 'Dieser Einkauf wurde nicht gefunden.' }, 404);
        return json({ deleted: true, id: deletedPurchase.id });
      } catch (error) {
        // Künftige Verkäufe sollen purchase_id mit ON DELETE RESTRICT verknüpfen.
        if (/FOREIGN KEY constraint failed/i.test(error.message || '')) {
          return json({ error: 'Dieser Einkauf kann nicht gelöscht werden, weil ihm noch Verkäufe zugeordnet sind.' }, 409);
        }
        throw error;
      }
    }

    if (!isUpdate && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM purchases ORDER BY purchase_date DESC, id DESC'
      ).all();
      return json({ purchases: results });
    }

    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: 'Bitte JSON senden (Content-Type: application/json).' }, 415);
    }
    // Das Frontend sendet denselben Origin. Fremde Webseiten dürfen hier nicht schreiben.
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) {
      return json({ error: 'Diese Anfrage stammt von einer anderen Webseite.' }, 403);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ error: 'Die Anfrage enthält kein gültiges JSON.' }, 400);
    }
    const { errors, purchase } = validatePurchase(data);
    if (Object.keys(errors).length) {
      return json({ error: 'Bitte die Eingaben prüfen.', errors }, 400);
    }

    if (isUpdate) {
      // Nur die bearbeitbaren Felder ändern; id und created_at bleiben unverändert.
      const updatedPurchase = await env.DB.prepare(`
        UPDATE purchases
        SET purchase_date = ?, kind = ?, description = ?, price_cents = ?,
            quantity = ?, source = ?, owner = ?, notes = ?
        WHERE id = ?
        RETURNING *
      `).bind(purchase.purchase_date, purchase.kind, purchase.description, purchase.price_cents,
        purchase.quantity, purchase.source, purchase.owner, purchase.notes, purchaseId).first();

      if (!updatedPurchase) return json({ error: 'Dieser Einkauf wurde nicht gefunden.' }, 404);
      return json({ purchase: updatedPurchase });
    }

    const savedPurchase = await env.DB.prepare(`
      INSERT INTO purchases (purchase_date, kind, description, price_cents, quantity, source, owner, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).bind(purchase.purchase_date, purchase.kind, purchase.description, purchase.price_cents,
      purchase.quantity, purchase.source, purchase.owner, purchase.notes).first();
    return json({ purchase: savedPurchase }, 201);
  } catch (error) {
    if (/purchase_price_below_item_costs/.test(error.message || '')) {
      return json({ error: 'Der Einkaufspreis darf nicht niedriger sein als die bereits zugeordneten Artikelkosten.' }, 409);
    }
    console.error('Einkaufsdatenbank:', error);
    return json({ error: 'Die lokale Einkaufsdatenbank ist nicht erreichbar. Bitte die Datenbankmigration ausführen und erneut versuchen.' }, 500);
  }
}
