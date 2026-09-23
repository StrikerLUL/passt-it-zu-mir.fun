# Anleitung – passt-it-zu-mir.fun

## Einmalig: Server auf GitHub-Updates umstellen

Auf dem VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/StrikerLUL/passt-it-zu-mir.fun/main/deploy/setup.sh -o /tmp/setup.sh
sudo bash /tmp/setup.sh
```

Das Skript:

- klont das Repo nach `/opt/passt-it-zu-mir`.
- übernimmt die bisherige Statistik nach `/var/lib/passt-it-zu-mir`.
- behält den Admin-Schlüssel und erzeugt ein Webhook-Secret. Beides liegt in `/etc/passt-it-zu-mir.env`, zusätzlich zum Nachschauen in `/root/fisi-quiz-admin-key.txt` und `/root/fisi-quiz-webhook-secret.txt`.
- stellt den Dienst `fisi-quiz` auf den neuen Ordner um.

nginx und das Zertifikat bleiben, wie sie sind. Der Port ist weiterhin 3847.

## Einmalig: Webhook bei GitHub anlegen

Im Repo unter **Settings → Webhooks → Add webhook**:

| Feld | Wert |
|---|---|
| Payload URL | `https://passt-it-zu-mir.fun/api/deploy` |
| Content type | `application/json` |
| Secret | Inhalt von `sudo cat /root/fisi-quiz-webhook-secret.txt` |
| SSL verification | Enable |
| Events | Just the push event |

Nach dem Speichern schickt GitHub einen Test („ping"). Unter *Recent Deliveries* sollte ein grüner Haken erscheinen.

## Alltag: Änderungen veröffentlichen

1. Dateien ändern, committen und auf `main` pushen.
2. Der Server holt sich den neuen Stand automatisch und startet neu. Das dauert nur ein paar Sekunden, und die Handy-Seite ist sofort aktuell.
3. Am Messe-Laptop: **Strg + Alt + A** → *Updates von GitHub*.
   - Dort steht, ob eine neue Bildschirm-Version verfügbar ist.
   - *Neueste Bildschirm-Datei herunterladen*: Die alte Datei durch die neue ersetzen (gleicher Ordner, gleicher Name) und öffnen. Die Einstellungen bleiben erhalten.
   - Falls der Webhook mal nicht greift: *Server jetzt aktualisieren* macht dasselbe per Knopfdruck.

## Messe-Laptop einrichten

1. `kiosk/messe-bildschirm.html` in Chrome oder Edge öffnen. Beim ersten Mal nimmst du die Datei aus dem Repo, danach geht es über das Admin-Menü.
2. **Strg + Alt + A**: bei Webseite `https://passt-it-zu-mir.fun` eintragen, dazu den Admin-Schlüssel (`sudo cat /root/fisi-quiz-admin-key.txt`). Dann *Verbindung testen* → *Speichern*.
3. Mit **F** in den Vollbildmodus.

## Tastenkürzel (nirgends sichtbar)

| Kürzel | Funktion |
|---|---|
| Strg + D | Quiz am Bildschirm starten |
| Strg + Alt + A | Admin-Menü |
| F | Vollbild |
| 1–5 | Antwort wählen |
| Esc | zurück zum Start |

## Nützliche Befehle auf dem VPS

```bash
systemctl status fisi-quiz                 # läuft der Dienst?
journalctl -u fisi-quiz -n 30 --no-pager   # Logs, auch von Updates
curl -s http://127.0.0.1:3847/api/version  # welcher Stand läuft?
sudo bash /opt/passt-it-zu-mir/deploy/setup.sh   # alles neu einrichten (Daten + Schlüssel bleiben)
```

## Daten

Gespeichert werden nur Zählerstände pro Tag, also wie oft welches Ergebnis herauskam. Es werden keine Namen, Antworten oder Geräte-Daten abgelegt.
