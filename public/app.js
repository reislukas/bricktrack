// Alle Angaben sind frei erfunden. Es gibt noch keine Verbindung zum Backend.
// Geldbeträge stehen in Cent, damit später keine Rundungsfehler entstehen.
const activities = [
  { title: 'Weltraum-Set', detail: 'Verkauf · 06.11.2026', type: 'sale', owner: 'Jonas', amount: 12900 },
  { title: 'Konvolut: City & Fahrzeuge', detail: 'Einkauf · 05.11.2026', type: 'purchase', owner: 'Gemeinsam', amount: 18000 },
  { title: 'Modulares Stadthaus', detail: 'Verkauf · 04.11.2026', type: 'sale', owner: 'Gemeinsam', amount: 23000 },
  { title: 'Technik-Fahrzeug', detail: 'Einkauf · 03.11.2026', type: 'purchase', owner: 'Fred', amount: 9500 },
  { title: 'Konvolut: bunte Bausteine', detail: 'Einkauf · 02.11.2026', type: 'purchase', owner: 'Jonas', amount: 14500 },
];

const currency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
let selectedType = 'all';
const ownerFilter = document.querySelector('#owner-filter');
const filterButtons = document.querySelectorAll('[data-filter]');

// Die Kennzahlen beziehen sich immer auf alle Beispieldaten, unabhängig vom Filter.
function showTotals() {
  const purchases = activities.filter(activity => activity.type === 'purchase');
  const sales = activities.filter(activity => activity.type === 'sale');
  const purchaseTotal = purchases.reduce((total, activity) => total + activity.amount, 0);
  const saleTotal = sales.reduce((total, activity) => total + activity.amount, 0);

  document.querySelector('#purchase-total').textContent = currency.format(purchaseTotal / 100);
  document.querySelector('#sale-total').textContent = currency.format(saleTotal / 100);
  document.querySelector('#activity-total').textContent = activities.length;
}

// Die Tabelle wird bei jeder Filteränderung neu aufgebaut.
function showActivities() {
  const visibleActivities = activities.filter(activity => {
    const matchesType = selectedType === 'all' || activity.type === selectedType;
    const matchesOwner = ownerFilter.value === 'all' || activity.owner === ownerFilter.value;
    return matchesType && matchesOwner;
  });

  const tableBody = document.querySelector('#activity-rows');
  tableBody.replaceChildren();

  for (const activity of visibleActivities) {
    const row = document.createElement('tr');
    const articleCell = document.createElement('td');
    const article = document.createElement('div');
    article.className = 'article';
    const icon = document.createElement('span');
    icon.className = `activity-icon ${activity.type}`;
    icon.textContent = activity.type === 'sale' ? '↗' : '↙';
    icon.setAttribute('aria-hidden', 'true');
    const description = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = activity.title;
    const detail = document.createElement('small');
    detail.textContent = activity.detail;
    description.append(title, detail);
    article.append(icon, description);
    articleCell.append(article);

    const ownerCell = document.createElement('td');
    const ownerBadge = document.createElement('span');
    ownerBadge.className = activity.owner === 'Gemeinsam' ? 'owner shared' : 'owner';
    ownerBadge.textContent = activity.owner;
    ownerCell.append(ownerBadge);

    const amountCell = document.createElement('td');
    amountCell.className = `amount ${activity.type}`;
    const sign = activity.type === 'sale' ? '+' : '−';
    amountCell.textContent = `${sign}${currency.format(activity.amount / 100)}`;
    row.append(articleCell, ownerCell, amountCell);
    tableBody.append(row);
  }

  if (visibleActivities.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'empty-state';
    cell.textContent = 'Keine Beispieldaten für diese Auswahl.';
    row.append(cell);
    tableBody.append(row);
  }

  document.querySelector('#activity-count').textContent = `${visibleActivities.length} von ${activities.length} Beispielaktivitäten · November 2026`;
}

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    selectedType = button.dataset.filter;
    for (const filter of filterButtons) {
      const isSelected = filter === button;
      filter.classList.toggle('active', isSelected);
      filter.setAttribute('aria-pressed', String(isSelected));
    }
    showActivities();
  });
}

ownerFilter.addEventListener('change', showActivities);
showTotals();
showActivities();
