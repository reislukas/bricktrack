
# 🧱 BrickTrack

**An entirely vibe-coded LEGO reselling inventory management app.**

A lightweight inventory management application built for **mancave**, a small LEGO reselling business.

Track purchases, manage LEGO collections and monitor sales — all in one place.

---

## ✨ Features

### ✅ Currently Implemented
- **Purchase Tracking** – Record purchases with automatically generated IDs.
- **Ownership Assignment** – Assign purchases to Jonas, Fred or shared ownership.
- **Persistent Database** – Store purchase data using Cloudflare D1 (SQLite).
- **Dashboard** – Modern, responsive interface with demo statistics.

### 🚧 Coming Soon
- **Sales Management** – Track sales across multiple LEGO collections.
- **Inventory Tracking** – Automatically calculate remaining stock.
- **Profit Calculation** – Track revenue, costs and profits.
- **Analytics** – Visualize business performance.
- **Authentication** – Secure access for multiple users.

---

## 🛠️ Tech Stack

- **Frontend:** HTML, CSS, Vanilla JavaScript
- **Backend:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite)
- **Version Control:** Git & GitHub

---

## 📸 Screenshots

*Dashboard screenshot coming soon.*

---

## 🚀 Getting Started

### Prerequisites
- Node.js 22+
- npm

### Installation

```bash
git clone https://github.com/reislukas/bricktrack.git
cd bricktrack
npm install
npm run db:migrate
npm run dev
```

Open **http://localhost:8787** in your browser.

The database runs locally. No Cloudflare deployment is required.

---

## 📌 Project Status

**🚧 Work in Progress**

BrickTrack is being developed step by step. The purchase management system is functional locally, while sales tracking, inventory management and analytics are planned for future releases.

---

*Built for mancave. Entirely vibe-coded. 🧱*
