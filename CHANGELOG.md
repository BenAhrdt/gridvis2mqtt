# Changelog

## [0.3.11] - 2026-09-26

- Historische Standardeinstellungen werden jetzt pro Gerät gespeichert. Zyklus, Versatz, Standard-Zeitbereiche und Vergleichszeiträume eines Geräts beeinflussen nur dieses Gerät; individuelle Messwert-Einstellungen überschreiben weiterhin die Gerätewerte.
- Der Backend-Historienplaner berücksichtigt die unterschiedlichen Gerätezyklen und Versätze auch beim MQTT-Publishing.

## [0.3.10] - 2026-09-26

- Der reguläre historische MQTT-Zyklus veröffentlicht Messwerte mit dem kleinsten konfigurierten Intervall auch dann, wenn ein Start- oder Reconnect-Abruf kurz zuvor bereits einen Cachewert geladen hat. Dadurch wird der erste planmäßige Zyklus nicht mehr fälschlich mit `dueJobs: 0` übersprungen.
- Der manuelle Historienabruf wartet jetzt auf einen laufenden Anzeigeabruf, statt den MQTT-Abruf stillschweigend zu verwerfen.

## [0.3.9] - 2026-09-26

- Das Deaktivieren von „MQTT aktiv“ löscht die Discovery nicht mehr. Die Entität bleibt vorhanden und erhält `offline` über ihr Availability-Topic; Werte werden während der Deaktivierung nicht veröffentlicht.
- Alte Zustände mit nur einer aktiven MQTT-Zuordnung werden beim nächsten Geräte-State-Commit vorsichtig um die fehlende Discovery-Zuordnung ergänzt. Das vollständige Entfernen eines Messwerts löscht die Discovery weiterhin.

## [0.3.8] - 2026-09-26

- GridVis-Basic-Authentifizierung ist jetzt eine ausdrückliche Einstellung und standardmäßig deaktiviert. Ohne aktivierte Option oder ohne Benutzername wird kein `Authorization`-Header gesendet.
- Die GridVis-Verbindungsseite erklärt die Authentifizierungsoption und übernimmt sie auch beim Verbindungstest.

## [0.3.7] - 2026-09-26

- Der MQTT-Startup-Sync vereinigt jetzt Discovery- und aktive MQTT-Zuordnungen. Dadurch erhalten alle aktiven Live- und historischen Messwerte beim Brokerstart Discovery und anschließend ihre Werte, auch wenn ältere Zustände die beiden Zuordnungstabellen nicht vollständig synchron gespeichert haben.

## [0.3.6] - 2026-09-26

- Historische Werte werden nach dem Aktivieren ihrer Discovery erneut aus GridVis geladen, auch wenn der zugehörige Scheduler-Job bereits vorher bekannt war.
- Der Übergang von fehlender/offline Discovery zu online löst jetzt einen gezielten seriellen Historienabruf aus; dadurch bleiben neu angelegte historische Entitäten nicht mehr ohne Wert.

## [0.3.5] - 2026-09-26

- Direkte Änderungen an historischen Auswahlen invalidieren jetzt laufende alte Browser-Abfragen, damit deaktivierte Messwerte nicht selbstständig wieder aktiviert werden.
- Verzögerte Discovery-Publish-Anfragen werden serverseitig gegen den aktuell gespeicherten MQTT-Status geprüft und können keine deaktivierten Messwerte wieder anlegen.
- Zusätzliche Discovery-Logdaten zeigen angeforderte, veröffentlichte, vorgemerkte und wegen eines inaktiven Zustands übersprungene Nachrichten.

## [0.3.4] - 2026-09-26

- Offene Browser-State-Commits werden vor Broker-Verbindung und manuellem Historienabruf abgewartet.
- Das Wiederanhaken eines historischen Messwerts veröffentlicht seine MQTT-Discovery nach dem Backend-Commit explizit erneut.
- Discovery-Synchronisierungen protokollieren jetzt auch „keine Änderung“ und „kein verbundener Broker“ eindeutig.

## [0.3.3] - 2026-09-26

- Broker-Reconnects veröffentlichen Discovery und bereits gecachte Live-/Historienwerte sofort aus dem Backend, ohne auf eine geöffnete Geräteseite zu warten.
- Bei einem Reconnect werden nur Werte ohne Backend-Cache initial aus GridVis geladen; ein vollständiger erzwungener Historienabruf und ein zusätzlicher Geräteinformationsscan entfallen.
- Historienabrufe bleiben aggregierte `histenergy`-Anfragen ohne `timebase`; dies wird zusätzlich im Logbuch des Broker-Syncs dokumentiert.
- Der MQTT-Verbindungsstatus wird aus dem tatsächlichen Backend-Laufzeitstatus angezeigt und bleibt beim Neurendern der Verbindungsseite erhalten.
- Erfolgreiche Einzeltests, Verbindungsaufbau, Wiederverbindung, Trennung und Verbindungsfehler werden in der Brokerkarte korrekt unterschieden.

## [0.3.2] - 2026-09-26

- Der manuelle Historienabruf aktualisiert die aktiven Historienwerte des geöffneten Geräts jetzt über die Backend-Queue und veröffentlicht sie anschließend per MQTT.
- Der manuelle Live-Abruf umgeht den Live-Cache und fragt die Werte frisch aus GridVis ab, bevor aktive Werte veröffentlicht werden.
- Verspätete Discovery-Löschungen können eine zwischenzeitlich wieder aktivierte Entität nicht mehr löschen; der Zustand des Backends ist maßgeblich.
- Beim Entfernen eines Messwerts wird der gespeicherte Gerätezustand vor der Discovery-Bereinigung abgewartet.
- Broker-Verbindungsaktionen stehen unterhalb des Passwortfelds.

## [0.3.1] - 2026-09-26

- GridVis und einzelne MQTT-Broker können in der Oberfläche ausdrücklich getrennt und wieder verbunden werden.
- Eine getrennte GridVis-Verbindung stoppt automatische Live-, Historien- und Geräteinformationsabfragen sowie MQTT-Veröffentlichungen; laufende GridVis-Anfragen werden abgebrochen.
- Der getrennte Zustand wird gespeichert und bleibt auch nach einem Neustart erhalten.
- Zusätzliche Logbuch-Einträge dokumentieren manuelle Verbindungen, Trennungen und übersprungene Veröffentlichungen.

## [0.3.0] - 2026-09-26

- Neue Verwaltungskategorie „Einstellungen“ für Profil, Benutzerverwaltung, Backup/Restore und Updateprüfung.
- Eigenes Benutzerprofil kann den Benutzernamen und das Passwort ändern; das aktuelle Passwort muss bestätigt werden.
- Administratoren können Benutzer anlegen, Passwörter zurücksetzen und Benutzer entfernen.
- Die bisherige Einzelbenutzer-Authentifizierung wird beim ersten Zugriff automatisch in das neue Mehrbenutzerformat migriert.
- README um die tatsächlich verwendeten GridVis-REST-Ressourcen, den gebündelten `onlinevalues`-Aufruf und den manuellen Transfer auf einen Produktiv-LXC ergänzt.
- Installationsskript kopiert keine produktiven Konfigurations-, Zustands- oder Authentifizierungsdateien aus dem Quellordner.
- Installationsskript startet einen bereits laufenden Dienst bei einem Update zuverlässig neu; unbekannte API-Endpunkte werden im Logbuch protokolliert.
- Oberfläche auf ein einheitliches helles, Janitza-inspiriertes Design umgestellt; der Dark Mode wurde entfernt.
- Schwarzer Header und Navigationsrahmen beibehalten, den Übergang zur abgerundeten Arbeitsfläche optisch bereinigt.
- Der Button „Historische Werte abrufen“ aktualisiert nur die Anzeige; MQTT-historische Werte werden ausschließlich durch den Backend-Zyklus veröffentlicht.
- Historien-Scheduler und MQTT-Verbindungsaufbau protokollieren jetzt auch übersprungene Jobs, fehlende Verbindungen, Discovery-Filter, Leerantworten und Veröffentlichungsfehler im Logbuch.

## [0.2.0] - 2026-09-26

- Login für die Weboberfläche mit initialem Benutzer `admin`.
- Startpasswort `gridvis2mqtt` muss beim ersten Login geändert werden.
- Backup und Restore der MQTT-Zuordnungen, Messwertauswahl und Anwendungseinstellungen.
- Verbindungsdaten sind beim Backup optional und standardmäßig ausgeschlossen.
- Historische Werte werden über `histenergy` ohne `timebase` aggregiert abgefragt.
- Periodische DeviceInfo-Aktualisierung bleibt auf MQTT-aktive Geräte begrenzt.
- Grundgerüst für reproduzierbare Installation über `install.sh` und Updates über `update.sh`.
- Git-Update-Check in den Einstellungen; der eigentliche Web-Update-Start bleibt bis zur Freigabe eines vertrauenswürdigen Remotes bewusst deaktiviert.
- Die Geräte-Icon-API kann separat ohne Web-Login für Home Assistant freigegeben werden.
