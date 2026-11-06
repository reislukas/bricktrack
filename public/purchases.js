// Dieser Bereich nutzt die echte lokale API. Die Demo in app.js bleibt unabhängig.
const purchaseForm = document.querySelector('#purchase-form');
const purchaseRows = document.querySelector('#purchase-rows');
const purchaseFeedback = document.querySelector('#purchase-feedback');
const purchaseListStatus = document.querySelector('#purchase-list-status');
const savePurchaseButton = document.querySelector('#save-purchase');
const reloadPurchasesButton = document.querySelector('#reload-purchases');
const purchaseCurrency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

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
    purchaseRows.append(row);
  }
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

purchaseForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (savePurchaseButton.disabled) return;
  for (const field of purchaseForm.elements) field.removeAttribute('aria-invalid');
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
  savePurchaseButton.disabled = true;
  savePurchaseButton.textContent = 'Wird gespeichert …';
  purchaseFeedback.classList.remove('error');
  purchaseFeedback.textContent = '';
  try {
    const response = await fetch('/api/purchases', {
      method: 'POST',
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

    purchaseForm.reset();
    setDefaultPurchaseDate();
    purchaseFeedback.textContent = `Einkauf ${purchaseId(data.purchase.id)} wurde gespeichert.`;
    // Ein erneutes GET liest den Datensatz tatsächlich aus D1 zurück.
    await loadPurchases();
  } catch (error) {
    purchaseFeedback.classList.add('error');
    purchaseFeedback.textContent = `Speichern fehlgeschlagen: ${error.message}`;
  } finally {
    savePurchaseButton.disabled = false;
    savePurchaseButton.textContent = 'Einkauf speichern';
  }
});

reloadPurchasesButton.addEventListener('click', loadPurchases);
setDefaultPurchaseDate();
loadPurchases();
