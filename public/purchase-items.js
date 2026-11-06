// Ein eigener Bereich für den gewählten Einkauf. Die Kauf-ID kommt aus der Tabelle.
const itemPanel = document.querySelector('#purchase-items-panel');
const itemForm = document.querySelector('#purchase-item-form');
const itemRows = document.querySelector('#purchase-item-rows');
const itemFeedback = document.querySelector('#item-feedback');
const itemStatus = document.querySelector('#item-list-status');
const itemSave = document.querySelector('#save-purchase-item');
const itemCancel = document.querySelector('#cancel-item-edit');
const itemClose = document.querySelector('#close-purchase-items');
const itemReload = document.querySelector('#reload-purchase-items');
const itemMoney = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
let activeItemPurchaseId = null;
let editingItemId = null;
let displayedItems = [];
let itemSaving = false;
let itemLoadNumber = 0;

function displayArticleId(id) { return `A-${String(id).padStart(6, '0')}`; }

function resetItemForm() {
  editingItemId = null;
  itemForm.reset();
  itemCancel.hidden = true;
  itemSave.textContent = 'Artikel speichern';
  document.querySelector('#item-form-heading').textContent = 'Bestandsartikel hinzufügen';
  for (const field of itemForm.elements) field.removeAttribute('aria-invalid');
}

async function openPurchaseItems(id) {
  if (itemSaving) return;
  activeItemPurchaseId = id;
  resetItemForm();
  itemFeedback.textContent = '';
  itemFeedback.classList.remove('error');
  itemRows.replaceChildren();
  document.querySelector('#item-cost-summary').textContent = 'Kostenzuordnung wird geladen …';
  document.querySelector('#purchase-items-heading').textContent = `Bestandsartikel · K-${String(id).padStart(6, '0')}`;
  document.querySelector('#purchase-items-description').textContent = '';
  itemPanel.hidden = false;
  await loadPurchaseItems();
  itemPanel.scrollIntoView({ block: 'start' });
}

// Aktualisiert den geöffneten Bereich auch nach einer Einkaufsbearbeitung.
async function refreshOpenPurchaseItems(purchases) {
  if (activeItemPurchaseId === null) return;
  if (!purchases.some(purchase => purchase.id === activeItemPurchaseId)) {
    activeItemPurchaseId = null;
    itemPanel.hidden = true;
    return;
  }
  await loadPurchaseItems();
}

function showPurchaseItems(items) {
  displayedItems = items;
  itemRows.replaceChildren();
  for (const item of items) {
    const row = document.createElement('tr');
    for (const value of [displayArticleId(item.id), item.description, item.quantity,
      item.theme || '–', item.set_number || '–',
      item.allocated_cost_cents === null ? 'Noch nicht zugeordnet' : itemMoney.format(item.allocated_cost_cents / 100)]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    row.children[1].className = 'purchase-description';
    const actions = document.createElement('td');
    actions.className = 'purchase-actions';
    for (const [action, label, style] of [['edit', 'Bearbeiten', 'edit-purchase'], ['delete', 'Löschen', 'delete-purchase']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `filter ${style}`;
      button.dataset.itemAction = action;
      button.dataset.itemId = item.id;
      button.textContent = label;
      button.disabled = itemSaving;
      button.setAttribute('aria-label', `${displayArticleId(item.id)} ${label}`);
      actions.append(button);
    }
    row.append(actions);
    itemRows.append(row);
  }
}

async function loadPurchaseItems() {
  if (activeItemPurchaseId === null) return;
  const id = activeItemPurchaseId;
  const requestNumber = ++itemLoadNumber;
  itemReload.disabled = true;
  itemStatus.classList.remove('error');
  itemStatus.textContent = 'Bestandsartikel werden geladen …';
  try {
    const response = await fetch(`/api/purchases/${id}/items`, { cache: 'no-store' });
    const data = await response.json();
    if (requestNumber !== itemLoadNumber || id !== activeItemPurchaseId) return;
    if (!response.ok) throw new Error(data.error || 'Laden fehlgeschlagen.');
    document.querySelector('#purchase-items-description').textContent = data.purchase.description;
    document.querySelector('#item-cost-summary').textContent =
      `Einkaufspreis: ${itemMoney.format(data.purchase.price_cents / 100)} · Zugeordnet: ${itemMoney.format(data.allocated_cost_cents / 100)} · Noch nicht verteilt: ${itemMoney.format(data.unallocated_cost_cents / 100)} · Artikelzeilen ohne Kostenzuordnung: ${data.unassigned_item_count}`;
    showPurchaseItems(data.items);
    itemStatus.textContent = data.items.length ? `${data.items.length} Artikelzeilen erfasst.` : 'Noch keine Artikel erfasst. Eine vollständige Erfassung ist nicht erforderlich.';
  } catch (error) {
    if (requestNumber !== itemLoadNumber || id !== activeItemPurchaseId) return;
    itemStatus.classList.add('error');
    itemStatus.textContent = `${error.message} Bitte „Neu laden“ versuchen.`;
  } finally {
    if (requestNumber === itemLoadNumber) itemReload.disabled = itemSaving;
  }
}

function setItemSaving(value) {
  itemSaving = value;
  for (const button of [itemSave, itemCancel, itemClose, itemReload, ...itemRows.querySelectorAll('button')]) {
    button.disabled = value;
  }
}

itemForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (itemSaving || activeItemPurchaseId === null) return;
  for (const field of itemForm.elements) field.removeAttribute('aria-invalid');
  if (!itemForm.reportValidity()) return;
  const fields = itemForm.elements;
  const payload = { description: fields.description.value, quantity: Number(fields.quantity.value),
    theme: fields.theme.value, set_number: fields.set_number.value, allocated_cost: fields.allocated_cost.value };
  const isEdit = editingItemId !== null;
  const url = `/api/purchases/${activeItemPurchaseId}/items${isEdit ? `/${editingItemId}` : ''}`;
  setItemSaving(true);
  itemSave.textContent = 'Wird gespeichert …';
  itemFeedback.textContent = '';
  itemFeedback.classList.remove('error');
  try {
    const response = await fetch(url, { method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) {
      for (const name of Object.keys(data.errors || {})) fields.namedItem(name)?.setAttribute('aria-invalid', 'true');
      throw new Error([data.error, ...Object.values(data.errors || {})].filter(Boolean).join('\n'));
    }
    resetItemForm();
    itemFeedback.textContent = `Artikel ${displayArticleId(data.item.id)} wurde ${isEdit ? 'aktualisiert' : 'gespeichert'}.`;
    await loadPurchaseItems();
  } catch (error) {
    itemFeedback.classList.add('error');
    itemFeedback.textContent = error.message;
  } finally {
    setItemSaving(false);
    itemSave.textContent = editingItemId === null ? 'Artikel speichern' : 'Änderungen speichern';
  }
});

itemRows.addEventListener('click', async event => {
  if (itemSaving) return;
  const button = event.target.closest('[data-item-action]');
  if (!button) return;
  const item = displayedItems.find(value => value.id === Number(button.dataset.itemId));
  if (!item) return;
  if (button.dataset.itemAction === 'edit') {
    editingItemId = item.id;
    const fields = itemForm.elements;
    fields.description.value = item.description;
    fields.quantity.value = item.quantity;
    fields.theme.value = item.theme || '';
    fields.set_number.value = item.set_number || '';
    fields.allocated_cost.value = item.allocated_cost_cents === null ? '' : (item.allocated_cost_cents / 100).toFixed(2);
    itemCancel.hidden = false;
    itemSave.textContent = 'Änderungen speichern';
    document.querySelector('#item-form-heading').textContent = `Artikel bearbeiten · ${displayArticleId(item.id)}`;
    itemFeedback.textContent = '';
    itemFeedback.classList.remove('error');
    for (const field of itemForm.elements) field.removeAttribute('aria-invalid');
    fields.description.focus();
    return;
  }
  if (!window.confirm(`Artikel ${displayArticleId(item.id)} „${item.description}“ wirklich löschen?\nDer ursprüngliche Einkauf bleibt erhalten.`)) return;
  setItemSaving(true);
  itemFeedback.classList.remove('error');
  try {
    const response = await fetch(`/api/purchases/${activeItemPurchaseId}/items/${item.id}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Löschen fehlgeschlagen.');
    if (editingItemId === item.id) resetItemForm();
    itemFeedback.textContent = `Artikel ${displayArticleId(item.id)} wurde gelöscht.`;
    await loadPurchaseItems();
  } catch (error) {
    itemFeedback.classList.add('error');
    itemFeedback.textContent = error.message;
  } finally { setItemSaving(false); }
});

itemCancel.addEventListener('click', () => {
  if (itemSaving) return;
  resetItemForm();
  itemFeedback.classList.remove('error');
  itemFeedback.textContent = 'Bearbeitung abgebrochen. Der Artikel wurde nicht geändert.';
});
itemClose.addEventListener('click', () => {
  if (itemSaving) return;
  activeItemPurchaseId = null;
  itemLoadNumber++;
  itemPanel.hidden = true;
});
itemReload.addEventListener('click', loadPurchaseItems);
