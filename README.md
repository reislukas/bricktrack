# BrickTrack

Kleine Web-App für mancave mit HTML, CSS, Vanilla JavaScript und einem Cloudflare Worker.
Die Einkaufsverwaltung verwendet eine **ausschließlich lokale D1-Datenbank**.
Das dunkelblaue Design und das gelbe Logo bleiben erhalten.

## Lokal starten

Im Projektordner `/Users/lukas/bricktrack`:

```bash
npm run db:migrate
npm run dev
```

Die im Terminal ausgegebene lokale Adresse öffnen, normalerweise http://localhost:8787.
Bei bereits laufendem Entwicklungsserver nach der Konfigurationsänderung einmal neu starten.
Für das Frontend den Worker verwenden, nicht die HTML-Datei direkt öffnen.

`db:migrate` legt die Tabelle beim ersten Aufruf an. Weitere Aufrufe wenden nur noch
neue SQL-Migrationen an und löschen keine bestehenden Einkäufe. Es wird keine
Cloudflare-Datenbank im Internet angelegt; dafür ist keine Cloudflare-Datenbank-ID eingetragen.
Kein `--remote` und kein Deployment sind für diesen Entwicklungsschritt nötig.

## Welche Datei macht was?

- `public/index.html`: bestehende Übersicht plus Einkaufsformular und Tabelle.
- `public/styles.css`: bestehendes Design plus passende Formularstile.
- `public/app.js`: unveränderte fiktive Kennzahlen und Beispielaktivitäten.
- `public/purchases.js`: lädt Einkäufe, sendet das Formular an die API und zeigt Antworten an.
- `src/index.js`: leitet `/api/purchases` an die Einkaufs-API weiter. Das bisherige
  Durable-Object-Begrüßungsbeispiel bleibt für andere Aufrufe erhalten.
- `src/purchases.js`: prüft Eingaben und führt parametrisierte SQL-Abfragen aus.
- `migrations/0001_create_purchases.sql`: erstellt die Tabelle mit zusätzlichen SQL-Prüfungen.
- `wrangler.jsonc`: ergänzt das D1-Binding `DB` für `bricktrack-local`.
  Die bisherigen Durable-Object-Einstellungen bleiben erhalten.
- `package.json`: enthält zusätzlich die Befehle `db:migrate` und `test`.
- `tests/purchases.test.mjs`: Funktionstest mit eigenem temporärem Datenbankspeicher.

## Datenmodell

Jede Zeile in `purchases` ist ein gesamter Einkauf, entweder `Einzelkauf` oder `Konvolut`.

| Spalte | Bedeutung |
| --- | --- |
| `id` | Automatisch hochgezählte eindeutige Zahl; Anzeige z. B. `K-000001` |
| `purchase_date` | Einkaufsdatum als `JJJJ-MM-TT` |
| `kind` | Einzelkauf oder Konvolut |
| `description` | Beschreibung, 1–200 Zeichen |
| `price_cents` | Gesamtpreis als ganze Cent-Zahl, 0–999.999.999 Cent |
| `quantity` | Ganze Anzahl von 1 bis 1.000.000 |
| `source` | Bezugsquelle, 1–120 Zeichen |
| `owner` | Jonas, Fred oder Gemeinsam |
| `notes` | Optionale Notizen, höchstens 2000 Zeichen |
| `created_at` | Automatisch erzeugter Erfassungszeitpunkt in UTC |

Der Einkaufspreis ist **der Gesamtpreis**, nicht der Stückpreis. Ein unsortiertes
Konvolut kann als Menge 1 erfasst werden. Die Menge ist die Anzahl gekaufter Einheiten;
Einzelteile eines Konvoluts werden in diesem Schritt noch nicht separat verwaltet.
`Gemeinsam` hält die Eigentumsart fest; eine 50/50-Gewinnberechnung folgt später.

Geld wird als ganze Zahl gespeichert: 12,50 € entspricht 1250 Cent.
Die API nimmt den Preis als Zeichenkette an und zerlegt Euro und Cent ohne
Fließkomma-Multiplikation. So entstehen keine versehentlichen Bruchteile von Cent.

## Wie Speichern funktioniert

1. Das Formular prüft Pflichtfelder, Wertebereiche und Längen im Browser.
2. `public/purchases.js` sendet JSON an `POST /api/purchases`.
3. Der Worker prüft die Angaben erneut, auch bei direkten API-Aufrufen.
4. `env.DB.prepare(...).bind(...)` schreibt den Datensatz mit SQL-Platzhaltern.
   Eingaben werden dabei als Werte behandelt, niemals als SQL-Code.
5. D1 vergibt die ID. Die API antwortet mit dem gespeicherten Einkauf.
6. Das Frontend ruft `GET /api/purchases` auf und zeigt die Datenbankinhalte an.
   Derselbe GET-Aufruf erfolgt beim Neuladen der Seite.

Eingegebene Texte werden mit `textContent` dargestellt, damit HTML in Beschreibungen
oder Notizen nicht ausgeführt wird. Bei Fehlern bleibt das Formular ausgefüllt;
während des Speicherns verhindert der deaktivierte Button doppelte Klicks.

Der lokale Datenbestand liegt standardmäßig unter `.wrangler/state/v3/d1/` im
Projektordner. Er bleibt bei Seiten- und Worker-Neustarts erhalten und wird durch
`.gitignore` von Git ausgeschlossen. **Den Ordner nicht löschen**, wenn die lokalen
Einkäufe erhalten bleiben sollen. Er ist kein Cloud-Backup. Tests verwenden einen
anderen temporären Ordner und lassen diese Daten unverändert.

Die Übersicht oben enthält weiterhin ausschließlich ihre fiktiven Demo-Kennzahlen.
Die echte Einkaufsverwaltung darunter besitzt ihre eigene, anfangs leere Liste.
Es werden keine Excel- oder Geschäftsdaten importiert. Bearbeiten, Löschen, Verkäufe,
Bestandsberechnung und Benutzeranmeldung gehören zu späteren Entwicklungsschritten.

## API

- `GET /api/purchases`: `{ "purchases": [...] }`, nach Datum und ID absteigend sortiert.
- `POST /api/purchases`: legt einen Einkauf an; Antwort 201 mit `{ "purchase": {...} }`.

Beispiel für den POST-Inhalt (nur fiktive Daten):

```json
{
  "purchase_date": "2026-11-06",
  "kind": "Konvolut",
  "description": "Fiktives City-Konvolut",
  "price": "12.50",
  "quantity": 1,
  "source": "Fiktiver Flohmarkt",
  "owner": "Gemeinsam",
  "notes": "Nur ein Beispiel"
}
```

`Content-Type` muss `application/json` sein. Ungültige Angaben liefern Status 400
mit verständlichen Feldfehlern. Unterstützt sind nur GET und POST (sonst 405).
Die API enthält noch keine Benutzeranmeldung und wird in diesem Schritt nur lokal verwendet.

## Funktionstest

```bash
npm test
```

Der Test startet den echten Worker, legt eine eigene temporäre lokale D1 an und prüft:
Speichern und Lesen, automatische IDs, Cent-Beträge, Eigentümer, ungültige Eingaben,
Fehlerantworten und Persistenz nach vollständigem Worker-Neustart.
Die Testdaten werden anschließend zusammen mit der Testdatenbank entfernt.

Manuelle Prüfung im Browser:

1. Unter „Einkäufe“ einen fiktiven Einkauf ausfüllen und speichern.
2. Die zugewiesene Kauf-ID in der Tabelle prüfen.
3. Seite neu laden: Der Einkauf muss weiterhin erscheinen.
4. Optional `npm run dev` beenden und wieder starten: Die Daten bleiben erhalten.
5. Einen negativen Preis oder eine Menge mit Nachkommastellen versuchen: Die Eingabe wird abgewiesen.

Cloudflare-Dokumentation:
[Lokale D1-Entwicklung](https://developers.cloudflare.com/d1/best-practices/local-development/),
[D1-Migrationen](https://developers.cloudflare.com/d1/reference/migrations/).
