// Funktionstest mit echtem Worker und D1. Eigener temporärer Speicher,
// damit die Einkaufsdaten der Anwendung weder gelesen noch verändert werden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const wrangler = join(project, 'node_modules/wrangler/bin/wrangler.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stopWorker(worker) {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const stopped = new Promise(resolve => worker.once('exit', resolve));
  worker.kill('SIGTERM');
  const timer = setTimeout(() => worker.kill('SIGKILL'), 5000);
  await stopped;
  clearTimeout(timer);
}

async function startWorker(storage, port) {
  const worker = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port),
    '--persist-to', storage], { cwd: project, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  worker.stdout.on('data', chunk => { output += chunk; });
  worker.stderr.on('data', chunk => { output += chunk; });
  worker.on('error', error => { output += error.message; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (worker.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/purchases`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return worker;
    } catch { /* Die lokale Laufzeit startet noch. */ }
    await pause(250);
  }
  await stopWorker(worker);
  throw new Error(`Lokaler Worker startet nicht:\n${output}`);
}

test('Lokale Einkaufsverwaltung mit echter D1-Datenbank', { timeout: 120000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'bricktrack-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let worker;
  const executeSql = sql => exec(process.execPath, [wrangler, 'd1', 'execute', 'bricktrack-local',
    '--local', '--persist-to', storage, '--command', sql], { cwd: project, timeout: 30000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  const post = (data, headers = {}) => fetch(`${base}/api/purchases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  const example = { purchase_date: '2026-11-06', kind: 'Konvolut', description: 'FIKTIVER TEST: City-Konvolut',
    price: '123,45', quantity: 3, source: 'Fiktiver Test-Flohmarkt', owner: 'Gemeinsam', notes: '<b>Nur Testdaten</b>' };
  try {
    await exec(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'bricktrack-local', '--local', '--persist-to', storage], {
      cwd: project, timeout: 30000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    worker = await startWorker(storage, port);
    let saved;
    let deletedId;
    await t.test('Leere Datenbank, Formular und JavaScript werden ausgeliefert', async () => {
      assert.deepEqual(await (await fetch(`${base}/api/purchases`)).json(), { purchases: [] });
      const page = await fetch(base);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /id="purchase-form"/);
      const script = await fetch(`${base}/purchases.js`);
      assert.equal(script.status, 200);
      assert.match(await script.text(), /loadPurchases/);
    });
    await t.test('Konvolut speichern und aus D1 zurücklesen', async () => {
      const response = await post(example);
      assert.equal(response.status, 201);
      saved = (await response.json()).purchase;
      assert.ok(Number.isInteger(saved.id) && saved.id > 0);
      assert.equal(saved.price_cents, 12345);
      assert.equal(saved.quantity, 3);
      assert.equal(saved.notes, example.notes);
      const { purchases } = await (await fetch(`${base}/api/purchases`)).json();
      assert.deepEqual(purchases, [saved]);
    });
    await t.test('Einkauf bearbeiten: Werte ändern, ID und Erfassungszeit behalten', async () => {
      const edited = { ...example, purchase_date: '2026-11-05', description: 'FIKTIVER TEST: bearbeitetes Konvolut',
        price: '45.67', quantity: 5, source: 'Fiktiver Test-Onlineshop', owner: 'Fred', notes: 'Bearbeitete Testnotiz' };
      const response = await fetch(`${base}/api/purchases/${saved.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edited),
      });
      assert.equal(response.status, 200);
      const updated = (await response.json()).purchase;
      assert.equal(updated.id, saved.id, 'Die Kauf-ID darf sich nicht ändern.');
      assert.equal(updated.created_at, saved.created_at, 'Der Erfassungszeitpunkt bleibt erhalten.');
      assert.equal(updated.description, edited.description);
      assert.equal(updated.purchase_date, edited.purchase_date);
      assert.equal(updated.price_cents, 4567);
      assert.equal(updated.quantity, 5);
      assert.equal(updated.source, edited.source);
      assert.equal(updated.owner, edited.owner);
      assert.equal(updated.notes, edited.notes);
      saved = updated;

      const { purchases } = await (await fetch(`${base}/api/purchases`)).json();
      assert.equal(purchases.length, 1, 'Bearbeiten darf keinen zweiten Einkauf anlegen.');
      assert.deepEqual(purchases, [updated]);
    });
    await t.test('Ungültige Änderungen und unbekannte Kauf-IDs werden abgewiesen', async () => {
      const invalid = await fetch(`${base}/api/purchases/${saved.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...example, quantity: 0 }),
      });
      assert.equal(invalid.status, 400);
      const missing = await fetch(`${base}/api/purchases/999999`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(example),
      });
      assert.equal(missing.status, 404);
      const unsupported = await fetch(`${base}/api/purchases/${saved.id}`, { method: 'PATCH' });
      assert.equal(unsupported.status, 405);
      assert.equal(unsupported.headers.get('Allow'), 'PUT, DELETE');
      const { purchases } = await (await fetch(`${base}/api/purchases`)).json();
      assert.deepEqual(purchases, [saved], 'Ungültige Änderungen und fehlende IDs dürfen nichts verändern.');
    });
    await t.test('Ungültige Eingaben werden abgewiesen und nicht gespeichert', async () => {
      for (const invalid of [
        { description: '  ' }, { description: 'x'.repeat(201) }, { source: '' }, { source: 'x'.repeat(121) },
        { owner: 'Unbekannt' }, { kind: 'Verkauf' }, { quantity: 0 }, { quantity: 1.5 }, { quantity: '3' },
        { quantity: 1000001 }, { price: '-1' }, { price: '1.001' }, { price: '10000000' }, { price: 12.34 },
        { purchase_date: '2026-02-31' }, { purchase_date: '2026-13-01' }, { purchase_date: '1899-12-31' },
        { notes: 'x'.repeat(2001) }, { notes: 5 },
      ]) {
        const response = await post({ ...example, ...invalid });
        assert.equal(response.status, 400, JSON.stringify(invalid));
        assert.ok(Object.keys((await response.json()).errors).length > 0);
      }
      for (const invalid of [null, [], 'text']) assert.equal((await post(invalid)).status, 400);
      const { purchases } = await (await fetch(`${base}/api/purchases`)).json();
      assert.equal(purchases.length, 1);
    });
    await t.test('JSON-Fehler, falsche Methode und fremder Origin', async () => {
      assert.equal((await fetch(`${base}/api/purchases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
      assert.equal((await fetch(`${base}/api/purchases`, { method: 'POST', body: 'text' })).status, 415);
      const method = await fetch(`${base}/api/purchases`, { method: 'DELETE' });
      assert.equal(method.status, 405);
      assert.equal(method.headers.get('Allow'), 'GET, POST');
      assert.equal((await post(example, { Origin: 'https://example.invalid' })).status, 403);
      assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
    });
    await t.test('Einzelkäufe, alle Eigentümer, Cent-Genauigkeit und SQL-Parameter', async () => {
      let lastId = saved.id;
      for (const [owner, price, cents] of [['Jonas', '0.29', 29], ['Fred', '0', 0], ['Gemeinsam', '9999999.99', 999999999]]) {
        const response = await post({ ...example, kind: 'Einzelkauf', owner, price, description: "Fiktiv: '); DROP TABLE purchases; --" });
        assert.equal(response.status, 201);
        const purchase = (await response.json()).purchase;
        assert.ok(purchase.id > lastId);
        assert.equal(purchase.price_cents, cents);
        assert.equal(purchase.owner, owner);
        lastId = purchase.id;
      }
      deletedId = lastId;
    });
    await t.test('Löschen: unbekannte IDs, fremder Origin und verknüpfte Einkäufe sind geschützt', async () => {
      const missing = await fetch(`${base}/api/purchases/999999`, { method: 'DELETE' });
      assert.equal(missing.status, 404);
      const invalidPath = await fetch(`${base}/api/purchases/not-an-id`, { method: 'DELETE' });
      assert.equal(invalidPath.status, 404);
      assert.equal((await fetch(`${base}/api/purchases/0`, { method: 'DELETE' })).status, 400);
      assert.equal((await fetch(`${base}/api/purchases/999999999999999999999`, { method: 'DELETE' })).status, 400);
      const foreignOrigin = await fetch(`${base}/api/purchases/${deletedId}`, {
        method: 'DELETE', headers: { Origin: 'https://example.invalid' },
      });
      assert.equal(foreignOrigin.status, 403);

      // Simuliert einen späteren Verkaufsartikel mit festem Fremdschlüssel.
      await executeSql('CREATE TABLE sale_items (id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT)');
      await executeSql(`INSERT INTO sale_items (id, purchase_id) VALUES (1, ${saved.id})`);
      const linked = await fetch(`${base}/api/purchases/${saved.id}`, { method: 'DELETE' });
      assert.equal(linked.status, 409);
      assert.match((await linked.json()).error, /Verkäufe zugeordnet/);

      const { purchases } = await (await fetch(`${base}/api/purchases`)).json();
      assert.equal(purchases.length, 4, 'Fehlgeschlagene Löschversuche dürfen keinen Einkauf entfernen.');
      assert.ok(purchases.some(item => item.id === saved.id));
    });
    await t.test('Unverknüpften Einkauf dauerhaft löschen und Tabelle aktualisieren', async () => {
      const response = await fetch(`${base}/api/purchases/${deletedId}`, { method: 'DELETE' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { deleted: true, id: deletedId });
      const { purchases } = await (await fetch(`${base}/api/purchases`)).json();
      assert.equal(purchases.length, 3);
      assert.ok(!purchases.some(item => item.id === deletedId));
      assert.ok(purchases.some(item => item.id === saved.id));
      assert.equal((await fetch(`${base}/api/purchases/${deletedId}`, { method: 'DELETE' })).status, 404);
    });
    await t.test('Nach vollständigem Worker-Neustart bleiben andere Einkäufe erhalten', async () => {
      const before = await (await fetch(`${base}/api/purchases`)).json();
      await stopWorker(worker);
      worker = await startWorker(storage, port);
      const after = await (await fetch(`${base}/api/purchases`)).json();
      assert.equal(after.purchases.length, 3);
      assert.equal(after.purchases.find(item => item.id === saved.id).description, 'FIKTIVER TEST: bearbeitetes Konvolut');
      assert.ok(!after.purchases.some(item => item.id === deletedId));
      assert.deepEqual(after, before);
    });
  } finally {
    await stopWorker(worker);
    await rm(storage, { recursive: true, force: true });
  }
});


test('Löschen in der Oberfläche passiert erst nach ausdrücklicher Bestätigung', async () => {
  class Element {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.classList = { add() {}, remove() {} };
      this.disabled = false;
      this.hidden = false;
      this.value = '';
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() {}
    scrollIntoView() {}
    closest(selector) {
      if (selector === '[data-delete-purchase]' && this.dataset.deletePurchase) return this;
      if (selector === '[data-edit-purchase]' && this.dataset.editPurchase) return this;
      return null;
    }
    get lastElementChild() { return this.children.at(-1) || null; }
  }

  const form = new Element();
  const fieldNames = ['purchase_date', 'kind', 'description', 'price', 'quantity', 'source', 'owner', 'notes'];
  const fields = fieldNames.map(name => Object.assign(new Element(), { name }));
  form.elements = fields;
  for (const field of fields) form.elements[field.name] = field;
  form.elements.namedItem = name => fields.find(field => field.name === name) || null;
  form.reportValidity = () => true;
  form.reset = () => {};
  const ids = {
    '#purchase-form': form,
    '#purchase-rows': new Element(),
    '#purchase-feedback': new Element(),
    '#purchase-list-status': new Element(),
    '#save-purchase': new Element(),
    '#reload-purchases': new Element(),
    '#cancel-edit': new Element(),
    '#purchase-form-heading': new Element(),
  };
  const purchase = { id: 17, purchase_date: '2026-11-06', kind: 'Konvolut',
    description: 'FIKTIVER Löschtest-Konvolut', price_cents: 2500, quantity: 1,
    source: 'Fiktiver Testmarkt', owner: 'Jonas', notes: '' };
  const requests = [];
  let deleted = false;
  let confirmAnswer = false;
  const confirmations = [];
  const document = { querySelector: selector => ids[selector], createElement: () => new Element() };
  const fetchMock = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url, method });
    if (method === 'GET') return { ok: true, json: async () => ({ purchases: deleted ? [] : [purchase] }) };
    if (method === 'DELETE') {
      deleted = true;
      return { ok: true, json: async () => ({ deleted: true, id: purchase.id }) };
    }
    throw new Error(`Unerwarteter Testaufruf: ${method}`);
  };
  const source = await readFile(new URL('../public/purchases.js', import.meta.url), 'utf8');
  runInNewContext(source, { document, fetch: fetchMock, Intl, Date,
    window: { confirm: message => { confirmations.push(message); return confirmAnswer; } } });
  await new Promise(resolve => setImmediate(resolve));

  const row = ids['#purchase-rows'].children[0];
  const actions = row.children.at(-1);
  const deleteButton = actions.children.find(button => button.dataset.deletePurchase);
  assert.ok(deleteButton);

  const click = () => ids['#purchase-rows'].listeners.click({ target: deleteButton });
  await click();
  assert.match(confirmations[0], /K-000017.*FIKTIVER Löschtest-Konvolut/s);
  assert.deepEqual(requests.map(request => request.method), ['GET'], 'Bei Abbrechen darf kein DELETE gesendet werden.');
  assert.equal(ids['#purchase-rows'].children.length, 1, 'Bei Abbrechen bleibt der Einkauf in der Tabelle.');

  confirmAnswer = true;
  await click();
  assert.deepEqual(requests.map(request => request.method), ['GET', 'DELETE', 'GET']);
  assert.equal(ids['#purchase-rows'].children.length, 0, 'Nach bestätigtem Löschen wird die Tabelle neu geladen.');
  assert.match(ids['#purchase-feedback'].textContent, /K-000017 wurde gelöscht/);
});

test('Bestandsartikel: Migration bestehender Einkäufe, Mengen, Kosten und Verknüpfungen', { timeout: 120000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'bricktrack-items-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let worker;
  const execute = args => exec(process.execPath, [wrangler, 'd1', 'execute', 'bricktrack-local', '--local',
    '--persist-to', storage, ...args], { cwd: project, timeout: 30000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  const sql = command => execute(['--command', command]);
  const list = async (purchaseId = 42) => {
    const response = await fetch(`${base}/api/purchases/${purchaseId}/items`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const write = (method, path, data, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data),
  });
  const draft = { description: 'FIKTIVER TEST: Minifiguren', quantity: 3,
    theme: 'Star Wars', set_number: '', allocated_cost: '' };
  let unknownCostItem, zeroCostItem, paidItem, otherPurchaseId, concurrencyPurchaseId;
  let originalPurchase;
  try {
    // Zuerst nur das bisherige Schema erstellen und einen bestehenden Einkauf simulieren.
    await execute(['--file', join(project, 'migrations/0001_create_purchases.sql')]);
    await sql("INSERT INTO purchases (id, purchase_date, kind, description, price_cents, quantity, source, owner, notes, created_at) VALUES (42, '2026-11-06', 'Konvolut', 'FIKTIVER bestehender Einkauf', 10000, 1, 'Fiktiver Testmarkt', 'Gemeinsam', 'Bestehende Testnotiz', '2026-11-06 10:00:00')");
    await execute(['--file', join(project, 'migrations/0002_create_purchase_items.sql')]);
    worker = await startWorker(storage, port);

    await t.test('Neue Migration erhält Kauf-ID und alle vorhandenen Einkaufswerte', async () => {
      const { purchases } = await (await fetch(`${base}/api/purchases`)).json();
      assert.equal(purchases.length, 1);
      originalPurchase = purchases[0];
      assert.deepEqual(originalPurchase, { id: 42, purchase_date: '2026-11-06', kind: 'Konvolut',
        description: 'FIKTIVER bestehender Einkauf', price_cents: 10000, quantity: 1, source: 'Fiktiver Testmarkt',
        owner: 'Gemeinsam', notes: 'Bestehende Testnotiz', created_at: '2026-11-06 10:00:00' });
      const empty = await list();
      assert.deepEqual(empty.items, []);
      assert.equal(empty.unallocated_cost_cents, 10000);
    });
    await t.test('Unvollständige Erfassung und leere Kosten bleiben erlaubt; 0 ist ein eigener Wert', async () => {
      let response = await write('POST', '/api/purchases/42/items', draft);
      assert.equal(response.status, 201);
      unknownCostItem = (await response.json()).item;
      assert.equal(unknownCostItem.allocated_cost_cents, null);
      assert.equal(unknownCostItem.purchase_id, 42);
      assert.equal(unknownCostItem.quantity, 3, 'Ein Konvolut mit Einkaufsmenge 1 darf mehrere Einzelartikel enthalten.');
      response = await write('POST', '/api/purchases/42/items', { ...draft, description: 'Fiktiver Gratisartikel', allocated_cost: '0', theme: '' });
      assert.equal(response.status, 201);
      zeroCostItem = (await response.json()).item;
      assert.equal(zeroCostItem.allocated_cost_cents, 0);
      assert.equal(zeroCostItem.theme, null);
      const data = await list();
      assert.equal(data.unassigned_item_count, 1);
      assert.equal(data.allocated_cost_cents, 0);
      assert.equal(data.unallocated_cost_cents, 10000);
    });
    await t.test('Ganzzahlige Mengen und optionale Felder werden im Backend validiert', async () => {
      for (const invalid of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: '3' },
        { quantity: 1000001 }, { description: '' }, { theme: 'Unbekannt' }, { set_number: 'abc' },
        { allocated_cost: '-1' }, { allocated_cost: '0.001' }, { allocated_cost: 5 }, { allocated_cost: '10000000' }]) {
        const response = await write('POST', '/api/purchases/42/items', { ...draft, ...invalid });
        assert.equal(response.status, 400, JSON.stringify(invalid));
      }
      const response = await write('POST', '/api/purchases/42/items', { description: 'Fiktiver schlichter Artikel', quantity: 1 });
      assert.equal(response.status, 201);
      const item = (await response.json()).item;
      assert.equal(item.theme, null);
      assert.equal(item.set_number, null);
      assert.equal(item.allocated_cost_cents, null);
      assert.equal((await write('DELETE', `/api/purchases/42/items/${item.id}`)).status, 200);
    });
    await t.test('Artikelkosten gelten für die ganze Menge und dürfen exakt den Einkaufspreis erreichen', async () => {
      let response = await write('POST', '/api/purchases/42/items', { ...draft, allocated_cost: '60,00', set_number: '75367' });
      assert.equal(response.status, 201);
      paidItem = (await response.json()).item;
      assert.equal(paidItem.allocated_cost_cents, 6000);
      assert.equal(paidItem.set_number, '75367');
      response = await write('PUT', `/api/purchases/42/items/${zeroCostItem.id}`, { ...draft, allocated_cost: '40.00' });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).item.id, zeroCostItem.id);
      const data = await list();
      assert.equal(data.allocated_cost_cents, 10000);
      assert.equal(data.unallocated_cost_cents, 0);
      assert.equal(data.unassigned_item_count, 1, 'Auch bei vollständig verteilten Kosten kann ein Artikel noch ohne Kostenzuordnung sein.');
      assert.equal((await write('POST', '/api/purchases/42/items', { ...draft, allocated_cost: '0.01' })).status, 409);
      assert.equal((await write('PUT', `/api/purchases/42/items/${unknownCostItem.id}`, { ...draft, allocated_cost: '0.01' })).status, 409);
      const after = await list();
      assert.equal(after.items.length, 3);
      assert.equal(after.items.find(item => item.id === unknownCostItem.id).allocated_cost_cents, null);
    });
    await t.test('Einkauf kann mit Artikeln nicht gelöscht und nicht unter die Artikelkosten abgesenkt werden', async () => {
      const removal = await write('DELETE', '/api/purchases/42');
      assert.equal(removal.status, 409);
      assert.match((await removal.json()).error, /Bestandsartikel/);
      const payload = { purchase_date: originalPurchase.purchase_date, kind: originalPurchase.kind,
        description: originalPurchase.description, price: '99.99', quantity: 1, source: originalPurchase.source,
        owner: originalPurchase.owner, notes: originalPurchase.notes };
      assert.equal((await write('PUT', '/api/purchases/42', payload)).status, 409);
      assert.deepEqual((await list()).purchase, originalPurchase);
      // Fremdschlüssel und Kostenlimit greifen auch bei direktem SQL.
      await assert.rejects(sql('DELETE FROM purchases WHERE id = 42'), /FOREIGN KEY constraint failed/i);
      await assert.rejects(sql('UPDATE purchases SET price_cents = 9999 WHERE id = 42'), /purchase_price_below_item_costs/);
      await assert.rejects(sql("INSERT INTO purchase_items (purchase_id, description, quantity) VALUES (999999, 'Fiktiver verwaister Artikel', 1)"), /FOREIGN KEY constraint failed/i);
    });
    await t.test('Artikel bearbeiten und löschen gibt Kosten frei; andere Artikel bleiben unverändert', async () => {
      const before = (await list()).items.find(item => item.id === paidItem.id);
      let response = await write('PUT', `/api/purchases/42/items/${paidItem.id}`, { ...draft, quantity: 5, allocated_cost: '50.00', theme: 'Harry Potter', set_number: '76400-1' });
      assert.equal(response.status, 200);
      const updated = (await response.json()).item;
      assert.equal(updated.id, before.id);
      assert.equal(updated.created_at, before.created_at);
      assert.equal(updated.quantity, 5);
      assert.equal(updated.theme, 'Harry Potter');
      assert.equal((await list()).unallocated_cost_cents, 1000);
      response = await write('DELETE', `/api/purchases/42/items/${zeroCostItem.id}`);
      assert.equal(response.status, 200);
      assert.equal((await list()).unallocated_cost_cents, 5000);
      assert.deepEqual((await list()).items.find(item => item.id === unknownCostItem.id), unknownCostItem);
      assert.equal((await write('DELETE', `/api/purchases/42/items/${zeroCostItem.id}`)).status, 404);
      response = await write('PUT', `/api/purchases/42/items/${paidItem.id}`, { ...draft, allocated_cost: '' });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).item.allocated_cost_cents, null);
    });
    await t.test('Einzelkäufe, falsche Herkunft, unbekannte IDs und ungültige Anfragen', async () => {
      const payload = { purchase_date: '2026-11-06', kind: 'Einzelkauf', description: 'Fiktiver Einzelkauf',
        price: '40', quantity: 1, source: 'Fiktiver Testmarkt', owner: 'Jonas', notes: '' };
      const response = await write('POST', '/api/purchases', payload);
      otherPurchaseId = (await response.json()).purchase.id;
      assert.ok(otherPurchaseId > 42);
      assert.equal((await write('POST', `/api/purchases/${otherPurchaseId}/items`, { ...draft, allocated_cost: '40' })).status, 201);
      assert.equal((await write('PUT', `/api/purchases/${otherPurchaseId}/items/${paidItem.id}`, draft)).status, 404);
      assert.equal((await write('DELETE', `/api/purchases/${otherPurchaseId}/items/${paidItem.id}`)).status, 404);
      assert.equal((await fetch(`${base}/api/purchases/999999/items`)).status, 404);
      assert.equal((await write('POST', '/api/purchases/999999/items', draft)).status, 404);
      assert.equal((await write('PUT', '/api/purchases/42/items/999999', draft)).status, 404);
      assert.equal((await fetch(`${base}/api/purchases/0/items`)).status, 400);
      assert.equal((await fetch(`${base}/api/purchases/42/items/nope`, { method: 'DELETE' })).status, 400);
      assert.equal((await write('POST', '/api/purchases/42/items', draft, { Origin: 'https://example.invalid' })).status, 403);
      assert.equal((await fetch(`${base}/api/purchases/42/items`, { method: 'POST', body: 'text' })).status, 415);
      assert.equal((await fetch(`${base}/api/purchases/42/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
      assert.equal((await fetch(`${base}/api/purchases/42/items`, { method: 'DELETE' })).status, 405);
    });
    await t.test('Gleichzeitige Zuweisungen können gemeinsam den Preis nicht überschreiten', async () => {
      const created = await write('POST', '/api/purchases', { purchase_date: '2026-11-06', kind: 'Konvolut',
        description: 'Fiktiver Paralleltest', price: '10', quantity: 1, source: 'Test', owner: 'Fred' });
      concurrencyPurchaseId = (await created.json()).purchase.id;
      const replies = await Promise.all([1, 2].map(() => write('POST', `/api/purchases/${concurrencyPurchaseId}/items`, { ...draft, allocated_cost: '7' })));
      assert.deepEqual(replies.map(reply => reply.status).sort(), [201, 409]);
      const data = await list(concurrencyPurchaseId);
      assert.equal(data.allocated_cost_cents, 700);
      assert.equal(data.items.length, 1);
    });
    await t.test('Künftige Verkaufsverknüpfung schützt Artikel beim Bearbeiten und Löschen', async () => {
      // Nur ein Testvertrag für die spätere Verkaufstabelle, keine Verkaufsmigration.
      await sql('CREATE TABLE order_items (id INTEGER PRIMARY KEY, purchase_item_id INTEGER NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT)');
      await sql(`INSERT INTO order_items VALUES (1, ${paidItem.id})`);
      const before = await list();
      assert.equal((await write('PUT', `/api/purchases/42/items/${paidItem.id}`, draft)).status, 409);
      assert.equal((await write('DELETE', `/api/purchases/42/items/${paidItem.id}`)).status, 409);
      await assert.rejects(sql(`DELETE FROM purchase_items WHERE id = ${paidItem.id}`), /FOREIGN KEY constraint failed/i);
      assert.deepEqual(await list(), before);
    });
    await t.test('Artikel, offene Kosten und bisherige Einkäufe überstehen den Neustart', async () => {
      const before = await list();
      await stopWorker(worker);
      worker = await startWorker(storage, port);
      assert.deepEqual(await list(), before);
      assert.deepEqual((await list()).purchase, originalPurchase);
      assert.equal((await list(otherPurchaseId)).items.length, 1);
      assert.equal((await list(concurrencyPurchaseId)).items.length, 1);
    });
  } finally {
    await stopWorker(worker);
    await rm(storage, { recursive: true, force: true });
  }
});

test('Artikeloberfläche: offene Kosten, 0 €, Bearbeiten, Abbrechen und Löschen', async () => {
  class Node {
    constructor(tag = 'div') {
      this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = '';
      this.attributes = {}; this.classList = { add() {}, remove() {} }; this.hidden = false;
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    addEventListener(event, handler) { this.listeners[event] = handler; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() {}
    scrollIntoView() {}
    closest(selector) { return selector === '[data-item-action]' && this.dataset.itemAction ? this : null; }
    querySelectorAll(tag) {
      return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]);
    }
  }
  const ids = Object.fromEntries(['purchase-items-panel', 'purchase-item-form', 'purchase-item-rows', 'item-feedback',
    'item-list-status', 'save-purchase-item', 'cancel-item-edit', 'close-purchase-items', 'reload-purchase-items',
    'item-form-heading', 'item-cost-summary', 'purchase-items-heading', 'purchase-items-description'].map(id => [`#${id}`, new Node()]));
  const form = ids['#purchase-item-form'];
  const fields = ['description', 'quantity', 'theme', 'set_number', 'allocated_cost'].map(name => Object.assign(new Node('input'), { name }));
  form.elements = fields;
  for (const field of fields) form.elements[field.name] = field;
  form.elements.namedItem = name => fields.find(field => field.name === name);
  form.reportValidity = () => true;
  form.reset = () => { for (const field of fields) field.value = field.name === 'quantity' ? '1' : ''; };
  const purchase = { id: 42, description: 'Fiktiver Oberflächentest', price_cents: 1000 };
  let items = [
    { id: 10, purchase_id: 42, description: 'Fiktiver offener Artikel', quantity: 3, theme: 'Star Wars', set_number: null, allocated_cost_cents: null },
    { id: 11, purchase_id: 42, description: 'Fiktiver Gratisartikel', quantity: 1, theme: null, set_number: null, allocated_cost_cents: 0 },
  ];
  const requests = [];
  let confirmDelete = false;
  const sandbox = { Intl, Date,
    document: { querySelector: selector => ids[selector], createElement: tag => new Node(tag) },
    window: { confirm: () => confirmDelete },
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      requests.push({ url, method, body: options.body });
      if (method === 'GET') return { ok: true, json: async () => ({ purchase, items,
        allocated_cost_cents: 0, unallocated_cost_cents: 1000,
        unassigned_item_count: items.filter(item => item.allocated_cost_cents === null).length }) };
      if (method === 'POST') {
        const data = JSON.parse(options.body);
        const item = { id: 12, purchase_id: 42, ...data, allocated_cost_cents: null };
        items.push(item);
        return { ok: true, json: async () => ({ item }) };
      }
      if (method === 'DELETE') {
        const id = Number(url.split('/').at(-1));
        items = items.filter(item => item.id !== id);
        return { ok: true, json: async () => ({ deleted: true, id }) };
      }
      throw new Error(`Unerwarteter Testaufruf: ${method}`);
    },
  };
  runInNewContext(await readFile(new URL('../public/purchase-items.js', import.meta.url), 'utf8'), sandbox);
  await sandbox.openPurchaseItems(42);
  const rows = ids['#purchase-item-rows'];
  assert.match(rows.children[0].children[5].textContent, /Noch nicht zugeordnet/);
  assert.match(rows.children[1].children[5].textContent, /0,00/);
  assert.match(ids['#item-cost-summary'].textContent, /10,00/);
  const action = (index, name) => rows.children[index].children.at(-1).children.find(button => button.dataset.itemAction === name);
  const click = button => rows.listeners.click({ target: button });
  await click(action(0, 'edit'));
  assert.equal(form.elements.allocated_cost.value, '');
  assert.equal(form.elements.description.value, items[0].description);
  const beforeCancel = requests.length;
  ids['#cancel-item-edit'].listeners.click();
  assert.equal(requests.length, beforeCancel);
  assert.equal(form.elements.description.value, '');
  await click(action(1, 'edit'));
  assert.equal(form.elements.allocated_cost.value, '0.00');
  ids['#cancel-item-edit'].listeners.click();

  form.elements.description.value = 'Fiktiver neuer Artikel';
  form.elements.quantity.value = '2';
  await form.listeners.submit({ preventDefault() {} });
  const submitted = JSON.parse(requests.find(request => request.method === 'POST').body);
  assert.equal(submitted.allocated_cost, '');
  assert.equal(submitted.quantity, 2);
  assert.equal(rows.children.length, 3);
  const beforeDelete = requests.length;
  await click(action(0, 'delete'));
  assert.equal(requests.length, beforeDelete, 'Abbrechen der Löschabfrage sendet keine Anfrage.');
  confirmDelete = true;
  await click(action(0, 'delete'));
  assert.equal(rows.children.length, 2);
  assert.match(ids['#item-feedback'].textContent, /A-000010 wurde gelöscht/);
});
