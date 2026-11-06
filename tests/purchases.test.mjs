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
    });
    await t.test('Nach vollständigem Worker-Neustart bleiben die Daten erhalten', async () => {
      const before = await (await fetch(`${base}/api/purchases`)).json();
      await stopWorker(worker);
      worker = await startWorker(storage, port);
      const after = await (await fetch(`${base}/api/purchases`)).json();
      assert.equal(after.purchases.length, 4);
      assert.deepEqual(after, before);
    });
  } finally {
    await stopWorker(worker);
    await rm(storage, { recursive: true, force: true });
  }
});
