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
