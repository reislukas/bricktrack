// Dieser Bereich nutzt die echte lokale API. Die Demo in app.js bleibt unabhängig.
const purchaseForm = document.querySelector('#purchase-form');
const purchaseRows = document.querySelector('#purchase-rows');
const purchaseFeedback = document.querySelector('#purchase-feedback');
const purchaseListStatus = document.querySelector('#purchase-list-status');
const savePurchaseButton = document.querySelector('#save-purchase');
const reloadPurchasesButton = document.querySelector('#reload-purchases');
const cancelEditButton = document.querySelector('#cancel-edit');
const purchaseFormHeading = document.querySelector('#purchase-form-heading');
const purchaseCurrency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
let savedPurchases = [];
let editingPurchaseId = null;

function setDefaultPurchaseDate() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  purchaseForm.elements.purchase_date.value = `${today.getFullYear()}-${month}-${day}`;
}

function purchaseId(id) {
  return `K-${String(id).padStart(6, '0')}`;
}

function showSavedPurchases(purchases) {
  savedPurchases = purchases;
  purchaseRows.replaceChildren();
  for (const purchase of purchases) {
    const row = document.createElement('tr');
    const idCell = document.createElement('td');
    idCell.textContent = purchaseId(purchase.id);
    const date = document.createElement('small');
    date.textContent = purchase.purchase_date.split('-').reverse().join('.');
    idCell.append(date);

    const descriptionCell = document.createElement('td');
    descriptionCell.className = 'purchase-description';
    descriptionCell.textContent = purchase.description;
    const kind = document.createElement('small');
    kind.textContent = purchase.kind;
    descriptionCell.append(kind);
    row.append(idCell, descriptionCell);

    // textContent zeigt auch eingegebene HTML-Zeichen sicher als Text an.
    for (const value of [purchaseCurrency.format(purchase.price_cents / 100), purchase.quantity,
      purchase.source, purchase.owner, purchase.notes || '–']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    row.lastElementChild.className = 'purchase-notes';

    const actionCell = document.createElement('td');
    actionCell.className = 'purchase-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'filter edit-purchase purchase-row-action';
    editButton.dataset.editPurchase = purchase.id;
    editButton.textContent = 'Bearbeiten';
    editButton.setAttribute('aria-label', `${purchaseId(purchase.id)} bearbeiten`);
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'filter delete-purchase purchase-row-action';
    deleteButton.dataset.deletePurchase = purchase.id;
    deleteButton.textContent = 'Löschen';
    deleteButton.setAttribute('aria-label', `${purchaseId(purchase.id)} „${purchase.description}“ löschen`);
    actionCell.append(editButton, deleteButton);
    row.append(actionCell);
    purchaseRows.append(row);
  }
}


async function deleteSavedPurchase(purchase, button) {
  const date = purchase.purchase_date.split('-').reverse().join('.');
  const confirmed = window.confirm(
    `Möchtest du diesen Einkauf wirklich dauerhaft löschen?\n\n${purchaseId(purchase.id)} · ${purchase.description}\n${date} · ${purchaseCurrency.format(purchase.price_cents / 100)} · ${purchase.owner}\n\nDiese Aktion kann nicht rückgängig gemacht werden.`
  );
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = 'Wird gelöscht …';
  purchaseFeedback.classList.remove('error');
  purchaseFeedback.textContent = '';
  try {
    const response = await fetch(`/api/purchases/${purchase.id}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Löschen fehlgeschlagen.');

    const message = `Einkauf ${purchaseId(data.id)} wurde gelöscht.`;
    if (editingPurchaseId === purchase.id) {
      leaveEditMode({ message });
    } else {
      purchaseFeedback.textContent = message;
    }
    await loadPurchases();
  } catch (error) {
    purchaseFeedback.classList.add('error');
    purchaseFeedback.textContent = `Löschen fehlgeschlagen: ${error.message}`;
    button.disabled = false;
    button.textContent = 'Löschen';
  }
}

function clearValidationErrors() {
  for (const field of purchaseForm.elements) field.removeAttribute('aria-invalid');
}

function leaveEditMode({ reset = true, message = '' } = {}) {
  editingPurchaseId = null;
  cancelEditButton.hidden = true;
  cancelEditButton.disabled = false;
  savePurchaseButton.textContent = 'Einkauf speichern';
  purchaseFormHeading.textContent = 'Neuen Einkauf erfassen';
  clearValidationErrors();
  if (reset) {
    purchaseForm.reset();
    setDefaultPurchaseDate();
  }
  purchaseFeedback.classList.remove('error');
  purchaseFeedback.textContent = message;
}

function enterEditMode(purchase) {
  editingPurchaseId = purchase.id;
  cancelEditButton.hidden = false;
  purchaseFormHeading.textContent = `Einkauf bearbeiten · ${purchaseId(purchase.id)}`;
  savePurchaseButton.textContent = 'Änderungen speichern';
  clearValidationErrors();
  purchaseFeedback.classList.remove('error');
  purchaseFeedback.textContent = `Du bearbeitest ${purchaseId(purchase.id)}. Die Kauf-ID bleibt erhalten.`;

  const fields = purchaseForm.elements;
  fields.purchase_date.value = purchase.purchase_date;
  fields.kind.value = purchase.kind;
  fields.description.value = purchase.description;
  fields.price.value = (purchase.price_cents / 100).toFixed(2);
  fields.quantity.value = String(purchase.quantity);
  fields.source.value = purchase.source;
  fields.owner.value = purchase.owner;
  fields.notes.value = purchase.notes || '';
  purchaseForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  fields.description.focus({ preventScroll: true });
}

async function loadPurchases() {
  reloadPurchasesButton.disabled = true;
  purchaseListStatus.classList.remove('error');
  purchaseListStatus.textContent = 'Einkäufe werden geladen …';
  try {
    const response = await fetch('/api/purchases', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Einkäufe konnten nicht geladen werden.');
    showSavedPurchases(data.purchases);
    purchaseListStatus.textContent = data.purchases.length
      ? `${data.purchases.length} Einkäufe lokal gespeichert.`
      : 'Noch keine Einkäufe gespeichert. Erfasst oben euren ersten Einkauf.';
    return true;
  } catch (error) {
    purchaseListStatus.classList.add('error');
    purchaseListStatus.textContent = `Laden fehlgeschlagen: ${error.message} Bitte „Neu laden“ versuchen.`;
    return false;
  } finally {
    reloadPurchasesButton.disabled = false;
  }
}

purchaseRows.addEventListener('click', event => {
  const deleteButton = event.target.closest('[data-delete-purchase]');
  if (deleteButton) {
    const purchase = savedPurchases.find(item => item.id === Number(deleteButton.dataset.deletePurchase));
    if (purchase) return deleteSavedPurchase(purchase, deleteButton);
    return;
  }

  const editButton = event.target.closest('[data-edit-purchase]');
  if (!editButton) return;
  const purchase = savedPurchases.find(item => item.id === Number(editButton.dataset.editPurchase));
  if (purchase) enterEditMode(purchase);
});

cancelEditButton.addEventListener('click', () => {
  leaveEditMode({ message: 'Bearbeitung abgebrochen. Der Einkauf wurde nicht geändert.' });
});

purchaseForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (savePurchaseButton.disabled) return;
  clearValidationErrors();
  if (!purchaseForm.reportValidity()) return;

  const fields = purchaseForm.elements;
  const purchase = {
    purchase_date: fields.purchase_date.value,
    kind: fields.kind.value,
    description: fields.description.value,
    price: fields.price.value,
    quantity: Number(fields.quantity.value),
    source: fields.source.value,
    owner: fields.owner.value,
    notes: fields.notes.value,
  };
  const wasEditing = editingPurchaseId !== null;
  savePurchaseButton.disabled = true;
  cancelEditButton.disabled = wasEditing;
  savePurchaseButton.textContent = wasEditing ? 'Wird aktualisiert …' : 'Wird gespeichert …';
  purchaseFeedback.classList.remove('error');
  purchaseFeedback.textContent = '';
  try {
    const url = wasEditing ? `/api/purchases/${editingPurchaseId}` : '/api/purchases';
    const response = await fetch(url, {
      method: wasEditing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(purchase),
    });
    const data = await response.json();
    if (!response.ok) {
      const errors = data.errors || {};
      for (const name of Object.keys(errors)) fields.namedItem(name)?.setAttribute('aria-invalid', 'true');
      const firstInvalidField = Object.keys(errors).map(name => fields.namedItem(name)).find(Boolean);
      firstInvalidField?.focus();
      throw new Error([data.error, ...Object.values(errors)].filter(Boolean).join('\n') || 'Speichern fehlgeschlagen.');
    }

    const savedId = data.purchase.id;
    leaveEditMode({ message: wasEditing
      ? `Einkauf ${purchaseId(savedId)} wurde aktualisiert.`
      : `Einkauf ${purchaseId(savedId)} wurde gespeichert.` });
    // Ein erneutes GET liest den Datensatz tatsächlich aus D1 zurück.
    await loadPurchases();
  } catch (error) {
    purchaseFeedback.classList.add('error');
    purchaseFeedback.textContent = `Speichern fehlgeschlagen: ${error.message}`;
  } finally {
    savePurchaseButton.disabled = false;
    cancelEditButton.disabled = false;
    if (editingPurchaseId !== null) savePurchaseButton.textContent = 'Änderungen speichern';
  }
});

reloadPurchasesButton.addEventListener('click', loadPurchases);
setDefaultPurchaseDate();
loadPurchases();
