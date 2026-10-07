# GridVis2MQTT

GridVis2MQTT liest Projekte, Geräte, Live-Werte und historische Messwerte aus der Janitza GridVis REST API und veröffentlicht ausgewählte Werte über auswählbare MQTT-Discovery-Profile.

> [!IMPORTANT]
> **GridVis2MQTT ist ein privates und unabhängig entwickeltes Open-Source-Projekt und kein offizielles Produkt von Janitza electronics GmbH.**
>
> Es besteht keine Verbindung, Kooperation, Beauftragung oder sonstige Zugehörigkeit zu Janitza electronics GmbH. Das Projekt wird weder von Janitza entwickelt noch gewartet oder unterstützt. Die Verwendung erfolgt auf eigene Verantwortung.

## Aktueller Stand

Der erste Profil-Renderer ist `Home Assistant`. Die Anwendung bleibt intern GridVis- und Plattform-neutral; Discovery-Nachrichten werden nur als Ausgabeformat erzeugt. Discovery kann deaktiviert werden und der Prefix ist frei wählbar, zum Beispiel `homeassistant` oder `gridvis/discovery`. Ein eingegebenes `/#` wird als Namespace-Schreibweise akzeptiert und beim Veröffentlichen entfernt, weil MQTT-Wildcards nur beim Abonnieren, nicht beim Publizieren erlaubt sind.

Verwendete REST-Ressourcen:

- `/rest/1/projects`
- `/rest/1/projects/{project}/devices`
- `/rest/1/projects/{project}/devices/{device}` – Gerätedetails
- `/rest/1/projects/{project}/devices/{device}/connectiontest` – Verbindungs-/Statusinformationen
- `/rest/1/projects/{project}/onlinevalues?value=...` – gebündelte Livewertabfrage
- `/rest/1/projects/{project}/devices/{device}/online/values`
- `/rest/1/projects/{project}/devices/{device}/hist/values`
- `/rest/1/projects/{project}/devices/{device}/histenergy`
- `/rest/1/projects/{project}/deviceicon/{device}` – Gerätebild für die Icon-API
- `/rest/common/info/version/full`

Die beiden Ressourcen `.../online/values` und `.../hist/values` liefern die verfügbaren Messwertdefinitionen eines Geräts. Die tatsächlichen Livewerte werden anschließend gebündelt als JSON über `onlinevalues` gelesen. Historische Werte werden je Messwert und Zeitraum über `histenergy` als JSON angefordert, ohne `timebase`: GridVis liefert damit die Aggregation; Energie-/Verbrauchswerte werden als Summe und andere Werte als Durchschnitt ausgewertet. Die alte Einzelwert-/Zeitbasis-Route wird dafür nicht verwendet. Die GridVis-Version wird über `.../info/version/full` gelesen. Die lokale Dokumentation einer GridVis-Installation ist unter `/rest/doc/` verfügbar.

## Start

```bash
npm ci
npm start
```

Optional können `GRIDVIS_USERNAME`, `GRIDVIS_PASSWORD`, `GRIDVIS_AUTH_ENABLED`, `GRIDVIS_PROJECT`, `MQTT_USERNAME`, `MQTT_PASSWORD` und `MQTT_TOPIC_PREFIX` gesetzt werden. Die GridVis-Basic-Authentifizierung ist standardmäßig deaktiviert; `GRIDVIS_AUTH_ENABLED=true` aktiviert den Authorization-Header. Ohne diese Option bleiben Benutzername und Passwort gespeichert, werden aber nicht an GridVis gesendet.

Die Seite `Verbindungen` bündelt die GridVis-Quelle, MQTT-Broker und Discovery-/Topic-Profile. Messwerte werden in der Gerätedetailansicht einem oder mehreren Profilen zugewiesen; bei einer neuen MQTT-Zuordnung wird automatisch das Standardprofil vorgeschlagen. Die Oberfläche kann mehrere Broker und Profile verwalten. Ein Broker enthält nur die Verbindung; Topics sind Veröffentlichungs-Topics der Profile und keine Abonnements.

GridVis und jeder konfigurierte MQTT-Broker können dort ausdrücklich getrennt und wieder verbunden werden. Beim Trennen von GridVis werden automatische Live-, Historien- und Geräteinformationsabfragen gestoppt, laufende GridVis-Anfragen abgebrochen und keine neuen MQTT-Werte oder Discoveries veröffentlicht. Der Zustand wird gespeichert und bleibt nach einem Neustart erhalten.

Die Verbindungsseite speichert Konfigurationen für die lokale Entwicklung zusätzlich in `data/config.local.json`. Diese Datei ist in `.gitignore` eingetragen, wird mit restriktiven Dateirechten angelegt und nicht versioniert. Eine Vorlage liegt unter `data/config.local.example.json`. Umgebungsvariablen haben Vorrang vor den Werten aus dieser lokalen Datei.

Für den Produktivbetrieb `NODE_ENV=production` setzen und Zugangsdaten über Umgebungsvariablen oder einen Secret-Mount bereitstellen. Dann wird die lokale Entwicklungsdatei nicht automatisch gelesen. Ein über `GRIDVIS2MQTT_CONFIG_FILE` explizit angegebener Mount bleibt standardmäßig schreibgeschützt; für die von `install.sh` eingerichtete lokale Konfiguration wird `GRIDVIS2MQTT_ALLOW_CONFIG_WRITE=true` gesetzt, damit die Einstellungen dauerhaft über die Oberfläche gepflegt werden können.

Die Oberfläche ist anschließend unter [http://localhost:8080](http://localhost:8080) erreichbar.

## Installation und Update

Nach dem Klonen kann die Anwendung auf einem Linux-LXC als systemd-Dienst installiert werden. Das Skript muss als `root` ausgeführt werden; auf einem schlanken Debian-LXC ist `sudo` nicht erforderlich:

```bash
./install.sh
```

Standardmäßig verwendet die Installation `/opt/gridvis2mqtt`, `/var/lib/gridvis2mqtt` und Port `8080`. Der Dienst läuft dabei als `root`, damit auf einem schlanken LXC kein zusätzlicher Dienstbenutzer eingerichtet werden muss. Diese Werte können über `GRIDVIS2MQTT_INSTALL_DIR`, `GRIDVIS2MQTT_DATA_DIR` und `GRIDVIS2MQTT_PORT` angepasst werden. Das Skript kopiert keine lokalen Konfigurations-, Zustands- oder Authentifizierungsdateien aus dem Klon. Die Verbindung wird anschließend in der Weboberfläche eingerichtet.

Ein Update kann aus dem installierten Git-Klon oder – sobald eine GitHub-Release veröffentlicht wurde – direkt in `Verwaltung → Einstellungen` gestartet werden:

```bash
/opt/gridvis2mqtt/update.sh
```

Dabei werden lokale Änderungen abgelehnt, Laufzeitdaten gesichert, der Fast-forward-Stand geladen, Abhängigkeiten aktualisiert, der Dienst neu gestartet und die Erreichbarkeit geprüft. Die Ausgabe beziehungsweise die Oberfläche zeigt Download-Fortschritt, aktuellen Schritt und Gesamtlaufzeit. Voraussetzung ist, dass das Zielverzeichnis ein Git-Klon mit konfiguriertem `origin`-Remote und Upstream-Branch ist.

Wenn das Repository noch nicht auf GitHub liegt, kann der aktuelle Stand zunächst per `rsync` vom Entwicklungs-LXC auf den Produktiv-LXC übertragen werden. Dabei wird nur der Anwendungscode kopiert; die Laufzeitdaten unter `/var/lib/gridvis2mqtt` bleiben erhalten:

```bash
# auf dem Entwicklungs-LXC, aus dem geklonten Repository
rsync -a --info=progress2 \
  --exclude='node_modules/' \
  --exclude='data/config.local.json' \
  --exclude='data/config.json' \
  --exclude='data/state.local.json' \
  --exclude='data/state.json' \
  --exclude='data/auth.local.json' \
  --exclude='data/auth.json' \
  --exclude='data/update-status.json' \
  --exclude='data/backups/' \
  --exclude='data/device-icons/' \
  ./ ben@<PRODUKTIV-LXC-IP>:/home/ben/gridvis2mqtt-release/
```

Danach auf dem Produktiv-LXC als `root`:

```bash
su -
cd /home/ben/gridvis2mqtt-release
GRIDVIS2MQTT_INSTALL_DIR=/opt/gridvis2mqtt ./install.sh
```

`install.sh` installiert die neue Version, führt `npm ci` aus, schreibt die systemd-Konfiguration neu und startet den Dienst. Die produktiven Einstellungen, Zustände, Authentifizierung und Backups bleiben im separaten Datenverzeichnis erhalten. Sobald ein vertrauenswürdiges Git-Remote vorhanden ist, kann anschließend `update.sh` für die regulären Updates verwendet werden.

In den Einstellungen prüft „Nach Release suchen“ bei einem GitHub-Remote die aktuelle GitHub-Release über deren SemVer-Tag. Nur Administratoren können eine neue Release starten. Während des Updates werden Download, Installation, Abhängigkeiten, Neustart und Gesundheitsprüfung angezeigt; nach erfolgreichem Abschluss lädt die Webseite einmal automatisch neu. Ein unbekanntes oder nicht auf GitHub liegendes Remote wird nicht automatisch ausgeführt.

### GitHub-Repository und Releases

Für dieses Repository ist folgende Einrichtung vorgesehen:

```bash
git remote add origin git@github.com:BenAhrdt/gridvis2mqtt.git
git push -u origin main
git tag -a v0.4.0 -m "Release v0.4.0"
git push origin v0.4.0
```

Anschließend wird auf GitHub aus dem Tag `v0.4.0` eine Release angelegt. Für jede weitere Veröffentlichung werden `package.json`, `package-lock.json` und der oberste Eintrag in `CHANGELOG.md` gemeinsam aktualisiert. Die Versionsnummern verwenden Semantic Versioning (`MAJOR.MINOR.PATCH`); die Updateprüfung berücksichtigt nur gültige Release-Tags wie `v0.4.1` oder `v1.0.0`.

Das Repository kann öffentlich angelegt werden. Als Beschreibung eignet sich zum Beispiel „Liest Janitza GridVis-Daten und veröffentlicht ausgewählte Werte über MQTT“; der Unabhängigkeits- und Haftungshinweis in dieser README sollte unverändert erhalten bleiben. Als Lizenz ist MIT vorbereitet.

Die Geräte-Icon-API kann in den Anwendungseinstellungen separat ohne Web-Login freigegeben werden. Sie ist standardmäßig aktiviert, damit Home Assistant die in der Discovery veröffentlichte `iconURL` laden kann. Öffentlich erreichbar sind dabei ausschließlich die beiden Bildrouten; alle Daten- und Konfigurationsrouten bleiben geschützt.

## Anmeldung

Die Weboberfläche ist durch eine lokale Sitzung geschützt. Beim ersten Start gelten:

- Benutzername: `admin`
- Startpasswort: `gridvis2mqtt`

Das Startpasswort muss nach der ersten Anmeldung geändert werden. Die Authentifizierungsdatei liegt außerhalb des Repositorys und wird mit restriktiven Rechten angelegt. Sie enthält keine GridVis- oder MQTT-Zugangsdaten.

Unter „Verwaltung → Einstellungen“ kann das eigene Profil mit neuem Benutzernamen und Passwort gespeichert werden. Administratoren können dort weitere Benutzer anlegen, Passwörter zurücksetzen und Benutzer löschen. Die Authentifizierungsdatei verwendet gehashte Passwörter; sie wird nicht in Backups aufgenommen.

Eine Sitzung bleibt standardmäßig 30 Tage gültig und wird bei Aktivität verlängert. Die Dauer kann über `GRIDVIS2MQTT_SESSION_TTL_HOURS` gesetzt werden; maximal sind 365 Tage möglich, zum Beispiel `GRIDVIS2MQTT_SESSION_TTL_HOURS=720` für 30 Tage.

## Backup und Restore

In den Einstellungen gibt es unter „Backup und Restore“ einen JSON-Download und einen Restore-Upload. Standardmäßig werden Messwertauswahl, Geräte-/Messwertzuordnungen, MQTT-Profile, Zeitbereiche und Anzeigeeinstellungen gesichert, aber keine Verbindungsdaten.

Über die Checkbox „GridVis- und MQTT-Verbindungsdaten einschließen“ können diese Daten bewusst ergänzt werden. Dazu gehören dann auch die Passwörter im Klartext. Solche Backups sollten nur geschützt gespeichert und übertragen werden. Authentifizierungsdaten und Sitzungen werden grundsätzlich nie in das Backup aufgenommen.

## Architektur

```text
GridVis REST API -> GridVis2MQTT -> MQTT Broker -> Discovery profile
```

Discovery-Konfigurationen und Availability-Topics werden retained veröffentlicht. Die zuletzt veröffentlichten Discovery-Topics werden intern nachgehalten: Bei einer Broker-Verbindung werden aktive Discoveries sowie vorhandene Backend-Cachewerte unabhängig vom geöffneten Browser erneut gesendet; nur noch nicht gecachte Werte werden initial aus GridVis geladen. Deaktivierte oder veraltete Topics werden mit einer leeren retained Payload gelöscht. Messwert-State-Topics bleiben standardmäßig nicht retained, können aber je Messwert im Einstellungsdialog optional retained veröffentlicht werden. Die erste Version ist lesend ausgelegt; es werden noch keine Command-Topics erzeugt. DeviceInfo wird zyklisch nur für Geräte mit aktiven MQTT-Zuordnungen aktualisiert; andere Gerätedetails werden bei Bedarf geladen und serverseitig zwischengespeichert.

## Messwertanzeige und Home Assistant

Spannung und Leistung werden standardmäßig ohne Nachkommastellen angezeigt. Arbeit wird abhängig vom Betrag in Wh (unter 1000 Wh, 0 Nachkommastellen), kWh (unter 1000000 Wh, 1 Nachkommastelle) oder MWh (ab 1000000 Wh, 3 Nachkommastellen) dargestellt. Im Einstellungsdialog eines Messwerts lassen sich Anzeigeeinheit und Nachkommastellen unabhängig überschreiben oder auf Standard zurücksetzen. Die Einstellungen gelten für Live-Kacheln und Schnellübersicht und werden pro Projekt, Gerät und Messwert im Browser gespeichert.

Die Anzeige verändert keine MQTT-Nutzdaten: Werte und Genauigkeit bleiben wie von der API geliefert, beispielsweise Wirkarbeit in Wh. Die Discovery verwendet passende Sensor-Klassen für Energie, Leistung, Spannung, Strom, Frequenz, Blind-/Scheinleistung und Temperatur. Wirkarbeit, bezogene und gelieferte Wirkarbeit werden als `energy` mit `state_class: total_increasing` veröffentlicht (Zählerstand; ein Rückgang wird von Home Assistant als neuer Zählerzyklus behandelt). Explizite Netto-Energiezähler erhalten `total`. Die Kanalbezeichnung ist Teil des Sensornamens, Topics und IDs bleiben stabil.

Referenz: [MQTT Sensor](https://www.home-assistant.io/integrations/sensor.mqtt/), [Sensor-Klassen](https://developers.home-assistant.io/docs/core/entity/sensor/).

## Haftungsausschluss

GridVis2MQTT ist ein privates und unabhängig entwickeltes Open-Source-Projekt. Es handelt sich **nicht um ein offizielles Produkt von Janitza electronics GmbH**. Das Projekt wird weder von Janitza entwickelt noch gewartet oder unterstützt.

Der Name „GridVis“ sowie weitere Produkt- und Unternehmensbezeichnungen werden ausschließlich verwendet, um die Kompatibilität bzw. den technischen Bezug zu den entsprechenden Produkten zu beschreiben. Die jeweiligen Bezeichnungen und Marken sind Eigentum ihrer jeweiligen Rechteinhaber.

Die Software wird **ohne Gewährleistung und auf eigene Verantwortung** zur Verfügung gestellt. Der Autor übernimmt, soweit gesetzlich zulässig, keine Haftung für Schäden, Datenverluste, Fehlfunktionen oder sonstige Folgen, die unmittelbar oder mittelbar aus der Installation oder Nutzung dieser Software entstehen.

Bei Fragen, Problemen oder Fehlern im Zusammenhang mit GridVis2MQTT bitte die entsprechenden Möglichkeiten dieses GitHub-Projekts, beispielsweise GitHub Issues, verwenden und nicht den Janitza-Support kontaktieren.
