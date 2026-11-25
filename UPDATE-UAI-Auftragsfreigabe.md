# UAI-Auftragsfreigabe im Wiki

Das Update enthält die MediaWiki-Erweiterung **UserAI 0.1.0-beta.4.18**
und den lokalen **UAI-MCP-Server 0.1.0-dev.33**.

## Was sich ändert

- Im Chat erscheint ein kurzer Hinweis mit **Auftrag prüfen**. Im Wiki
  zeigt das UAI-Banner denselben Einstieg für den angemeldeten Betreuer.
- Die Spezialseite zeigt den vollständigen Entwurf, die Feldvorschläge
  oder den Abschlussbericht. Der Textbereich ist scrollbar. Die
  Schaltflächen und der Änderungswunsch stehen darunter.
- UAI ruft die Entscheidung unter derselben Auftrags-ID ab. Ein
  Änderungswunsch stoppt die vorgelegte Fassung. Eine offene Freigabe
  läuft nach 30 Minuten ab.
- Die vorhandene OAuth-Verbindungsfreigabe läuft weiterhin separat.

## Aktualisieren

1. **Auf dem MediaWiki-Server** den bisherigen Erweiterungsordner
   `extensions/UserAI` sichern und durch den Ordner `UserAI` aus diesem
   Archiv ersetzen. Die Wiki-Konfiguration bleibt in `LocalSettings.php`.
2. Im MediaWiki-Hauptordner, in dem `LocalSettings.php` liegt, einmal
   ausführen. Damit legt MediaWiki die neue Tabelle für Freigaben an.

   ```sh
   php maintenance/run.php update --quick
   ```

3. **Auf dem Rechner mit der ChatGPT-App** das Update für den bestehenden
   MCP-Server aus dem entpackten Archiv ausführen. Der Zielordner endet
   auf `server` und enthält die bisherige `package.json`. Für die
   bisherige Installation auf dem M2 lautet der Befehl aus dem
   entpackten Ordner `UAI-Auftragsfreigabe`

   ```sh
   bash server/update.sh "$HOME/Applications/UsaerAI/server"
   ```

4. Danach die ChatGPT-App neu starten. Für den neuen Ablauf müssen beide
   Komponenten aktualisiert sein. Der Aktualisierer des MCP-Servers
   belässt die private Konfiguration und die vorhandenen Auftragsakten
   am bisherigen Ort.

## Kurztest auf AufEinWort

Einen lesenden Auftrag mit langem Entwurf vorlegen. In ChatGPT erscheint
der Link **Auftrag prüfen**. Öffne denselben Auftrag über das Wiki-Banner,
scrolle bis zum Ende und gib den Auftrag dort frei. UAI soll im selben
Chat weiterarbeiten. Bei einem zweiten Entwurf soll **Stoppen** die
Ausführung unterbinden. Der Abschlussbericht lässt sich ebenfalls auf
seiner Wiki-Spezialseite bestätigen.

Die automatisierten Tests verwenden lokale Prüfstände. Der Kurztest mit
einer laufenden MediaWiki-Installation steht aus.
