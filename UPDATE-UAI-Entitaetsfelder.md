# UAI 0.1.0-dev.34

Das Update betrifft den lokalen UAI-MCP-Server. Es verwendet die bereits
installierte MediaWiki-Erweiterung UserAI 0.1.0-beta.4.18.

Ein Auftrag für ein bekanntes Entitätsfeld kann mit dem Werkzeug `auftrag`
direkt zur Wiki-Freigabe vorgelegt werden. Die Spezialseite zeigt Entität,
Schema, Feldschlüssel, Feldtyp, Operation und Wert. `sws_update_subject`
prüft vor dem Speichern die aktuelle SWS-Felddefinition und die Seitenrevision.
Die Felder werden zur Laufzeit aus dem Schema gelesen. Für den Auftrag genügt
die übliche Wiki-Freigabe.

## Aktualisieren

Im entpackten Ordner `UAI-Entitaetsfelder` auf dem Rechner mit der ChatGPT-App
den vorhandenen MCP-Server mit diesem Befehl aktualisieren:

```sh
bash server/update.sh "$HOME/Applications/UsaerAI/server"
```

Danach ChatGPT neu starten und den Auftrag für E3340 erneut vorlegen.
Die Verbindung und Auftragsfreigabe erfolgen weiterhin im Wiki.
