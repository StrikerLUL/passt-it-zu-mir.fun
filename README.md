# passt-it-zu-mir.fun

Messe-Quiz **„Systeme oder Software?"** – finde in 8 Fragen heraus, ob **Systemintegration** oder **Anwendungsentwicklung** zu dir passt. Ob Fachinformatik überhaupt passt, sagt das Quiz auch.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `server/server.js` | kleiner Node-Server (keine Pakete nötig): Handy-Seite, Zähler, Admin-API, Auto-Update |
| `server/public/index.html` | Handy-Seite (hinter dem QR-Code) |
| `kiosk/messe-bildschirm.html` | Bildschirm für den Messe-Laptop (läuft offline) |
| `deploy/setup.sh` | einmalige Einrichtung auf dem VPS |
| `deploy/nginx-passt-it-zu-mir.fun.conf` | nginx-Konfiguration |

## Updates

Jeder Push auf `main` aktualisiert den Server automatisch (GitHub-Webhook → `/api/deploy`). Die Handy-Seite ist damit sofort aktuell. Die Bildschirm-Datei für den Laptop lädst du im Admin-Menü (**Strg + Alt + A**) unter *Updates von GitHub* herunter.

Details stehen in der [ANLEITUNG.md](ANLEITUNG.md).

> Keine Schlüssel ins Repo committen! Admin-Schlüssel und Webhook-Secret liegen nur auf dem Server in `/etc/passt-it-zu-mir.env`.
