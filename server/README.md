# UAI MCP Server 0.1.0-dev.35

Eigenständiger MCP-Server über stdio für User AI ab 0.1.0-beta.4.
Softwaredesign Klaus Feldmann / AufEinWort, Programmierung ChatGPT / Sophos.
Der Server verwendet den UAI-Referenzclient und das offizielle TypeScript-SDK
von Model Context Protocol (Apache-2.0). Das Paket ist GPL-2.0-or-later.

## Einrichtung für den Paralleltest

1. Node.js ab Version 22 verwenden und im entpackten Ordner `npm ci` ausführen.
2. In einem separaten MCP-Profil das Programm `node` mit dem absoluten Pfad zu
   `src/start.mjs` eintragen. Das Programm spricht MCP über stdin/stdout.
3. Diesem Prozess die folgenden Einstellungen mitgeben.

| Variable | Wert |
|---|---|
| `UAI_ACTION_URL` | Action API des Wikis, etwa `https://wiki.example.org/w/api.php` |
| `UAI_REST_URL` | REST-Einstieg desselben Wikis, etwa `https://wiki.example.org/w/rest.php` |
| `UAI_CLIENT_ID` | OAuth-Client-Schlüssel |
| `UAI_CLIENT_SECRET` | Geheimnis des vertraulichen OAuth-Clients |
| `UAI_EXPECTED_ACTOR_ID` | Benutzer-ID des Assistentenkontos |

Für den aktuellen Auftragsablauf die MediaWiki-Erweiterung UserAI
0.1.0-beta.4.19 verwenden.

Mit `auftrag` einen Entwurf mit den Auswahlregeln vorlegen. Nach dessen
Freigabe recherchieren und unter derselben ID die konkreten Schreibvorgänge
als `aenderungen` mit `werkzeug` und `argumente` vorlegen. Nach der
Feldfreigabe die vorgelegten Argumente mit der `auftragsId` ausführen.
Die Warteabfrage für Aufträge unterstützt bis zu 300 Sekunden. Bei einem
Stopp kann ein bereits ausgelöster Wiki-Aufruf noch zu Ende laufen.
Nach einem expliziten Browser-Login als Assistent stehen beim App-Start
zunächst `uai-connect` und `uai-call` bereit. Im Chat sind „Verbinde dich UAI“
und „Connect UAI“ Beispiele für dieselbe Aufforderung. Die Werkzeugbeschreibung
weist die App darauf hin, Groß- und Kleinschreibung zu ignorieren.

Der erste Aufruf von `uai-connect` liefert den Freigabelink und den Prüfcode.
Die App zeigt beides im Chat und ruft das Werkzeug im selben Durchlauf erneut
mit `waitSeconds: 100` auf. Der Betreuer prüft Anwendung, Assistent und Prüfcode
im Wiki und gibt dort frei. Während der Wartezeit prüft der Server den Status
der bestehenden Anfrage. Sobald das Wiki die Freigabe bestätigt, übernimmt
die App die Sitzung ohne weiteren Chat-Prompt. Ist die Freigabe nach Ablauf
der Wartezeit noch offen, meldet der Server den offenen Status. `uai-call`
dient als lesender Aufrufweg in Apps, die ihre Werkzeugliste erst später
aktualisieren.

## Tests

`npm test` startet den Server als separaten Prozess und prüft
`initialize`, `tools/list` und `tools/call` über stdio gegen eine simulierte
MediaWiki-Verbindung. Der Test umfasst Eingabevalidierung, die Lesefreigabe
und die Weiterleitung einer authentifizierten SPARQL-Abfrage.

Dies ist ein interner Entwicklungsstand. Zusätzlich zu UAI stehen allgemeine
MediaWiki-Lesewerkzeuge für Seitenquelltext, Vorlagendokumentation, Volltextsuche,
Kategorien, Seitenverlauf und einzelne Revisionen zur Verfügung. Such-, Kategorie-
und Verlaufsergebnisse können seitenweise fortgesetzt werden.

`uai-call` bleibt bereits vor der Freigabe sichtbar. Nach `uai-connect` kann die
App darüber die verfügbaren Lesewerkzeuge entdecken und aufrufen, auch wenn sie
ihre eigene Werkzeugliste während des Chats nicht aktualisiert. Der Sammelaufruf
nimmt keine Schreiboperation an.

Für den internen Schreibtest stellt `UAI_ALLOW_PAGE_WRITES=1` die Werkzeuge
`create-page` und `update-page` bereit. Dafür muss das OAuth-Token über die
einschlägigen Bearbeitungsrechte verfügen. Eine Anlage verwendet `createonly`.
Beim Ersetzen einer Seite muss die gelesene Basisrevision mitgesendet werden.
Die Entitätenschreibwerkzeuge werden gesondert aktiviert.

Werkzeugbeschreibungen und Eingabedefinitionen kommen vom installierten UAI.
Deren Herkunft und Lizenzhinweise sind in dessen Katalog dokumentiert.

## Browser-Anmeldung

Im eigenen Wiki einen OAuth-2.0-Client für den Browser-Ablauf anlegen.
Die Eigentümerbindung („nur für die Verwendung durch …“) bleibt deaktiviert.
Als Ablauf **Autorisierungscode** und als Rückrufadresse exakt
`http://127.0.0.1:47832/oauth/callback` eintragen. Für den lokalen Client
„vertraulicher Client“ deaktivieren, falls das Wiki öffentliche PKCE-Clients
erlaubt. Benötigt das Wiki einen vertraulichen Client, muss das
Client-Geheimnis lokal als `UAI_CLIENT_SECRET` bereitgestellt werden.

Beispiel für das eigene Wiki und die ID des Assistentenkontos:

```sh
export UAI_ACTION_URL=https://wiki.example.org/w/api.php
export UAI_REST_URL=https://wiki.example.org/w/rest.php
export UAI_CLIENT_ID='Schlüssel des neuen OAuth-Clients'
export UAI_EXPECTED_ACTOR_ID=7
node src/start.mjs --login
```

Die Anmeldung mit dem eingerichteten Assistentenkonto durchführen. Der Abgleich der zugeordneten
Benutzer-ID erfolgt vor dem Speichern. Der Server lauscht für die Anmeldung
kurzzeitig auf dem lokalen Rückrufport und schließt ihn nach dem Rückruf oder
nach drei Minuten. Der OAuth-Code ist mithilfe von PKCE an diese Anmeldung
gebunden. Token werden lokal in einer Datei mit Modus 0600 gespeichert,
getrennt nach Wiki, Client-ID und Assistentenkonto.

Für den MCP-Start die gleichen vier Variablen in der MCP-Konfiguration
verwenden und `--login` weglassen. Ein abgelaufenes Zugriffstoken erfordert erneut `--login` und deine Browserfreigabe.
Der Server speichert ausschließlich Zugriffstoken und Ablaufzeit. Die optionale Einstellung
`UAI_ACCESS_TOKEN` verwendet weiterhin ein manuell bereitgestelltes Token
und hat beim normalen MCP-Start Vorrang vor der Browser-Anmeldung.

Optional kann `UAI_OAUTH_DIR` den Ordner für den lokalen Token-Cache festlegen.
Für Browser-Anmeldung und anschließenden MCP-Start denselben Ordner verwenden.

## Betreuerfreigabe auf dem Wiki

Eine Freigabeanfrage ist zwei Minuten gültig. Eine übernommene Sitzung
gilt bis zu 15 Minuten, solange auch das ursprüngliche OAuth-Zugriffstoken
gültig bleibt. Beim Schließen der Freigabeseite per Schaltfläche „Abbrechen
oder widerrufen“ prüft der nächste Wiki-Aufruf die Sperre. Der Sitzungsnachweis
bleibt im Arbeitsspeicher des MCP-Prozesses. Ein Neustart verlangt eine neue
Freigabe. Automatische OAuth-Token-Erneuerung ist deaktiviert.

## Seiten löschen

Bei aktiviertem Seiten-Schreibmodus ist `delete-pages` ein separates Werkzeug.
In der App eine Bestätigung für jeden Aufruf konfigurieren, etwa
`approval_mode = "approve"` beim Eintrag dieses Werkzeugs. Ein Aufruf enthält
eine konkrete Liste mit 1–25 Seitentiteln und einer Löschbegründung. Dieselbe
Bestätigung deckt alle Titel in diesem Aufruf ab. Für spätere Aufrufe gilt
die Bestätigung erneut. Weiterleitungen werden als die angegebenen Seiten
behandelt. Das Wiki prüft Löschrecht und Sitzung bei jeder Einzellöschung.

Die Liste hat einzelne Ergebnisse mit Löschlog-ID, soweit die Antwort die
Löschung bestätigt. Falls eine Antwort unklar ist, stoppt die Liste. Bereits
erfolgte Löschungen bleiben wirksam.

## Versionsvergleich und Weiterleitungen

`compare-pages` vergleicht zwei Revisions-IDs mit der MediaWiki-Diff-Engine.
Die IDs liefert `get-page-history`. `check-redirects` gibt den Weiterleitungsweg
einschließlich Abschnittsanker und direkt eingehende Weiterleitungen getrennt
für den angegebenen Seitentitel aus. `nextCursor` setzt die Liste der
eingehenden Weiterleitungen fort. Beide Werkzeuge sind lesend und nach
der Betreuerfreigabe auch über `uai-call` verfügbar.

## Verschieben, Wiederherstellen und Dateien

`move-pages` nimmt explizite Quell-Ziel-Paare an. Standardmäßig bleibt am
Quelltitel eine Weiterleitung. Hierfür gelten die MediaWiki-Rechte.
`undelete-pages` stellt die archivierten Versionen der genannten Seiten
wieder her. MediaWiki kann dabei eine schon neu angelegte Seite und ihre
alte Versionsgeschichte zusammenführen.

`get-file` liefert die Dateibeschreibungsseite, den Dateilink und Metadaten.
Für `download-files` und `upload-files` muss `UAI_FILE_DIRECTORY` auf einen
lokalen Dateiordner gesetzt sein. Die Aufrufe akzeptieren Dateinamen ohne
Pfad. Pro Datei gilt ein Limit von 20 MiB. Der Download lädt nur Dateien
vom selben Ursprung wie die Wiki-API und überschreibt keine lokale Datei.
Der Upload lässt MediaWiki-Warnungen wirksam und überspringt vorhandene
Dateien. Downloads von anderen Ursprüngen können über den Link aus
`get-file` separat im Browser erfolgen.

Alle vier verändernden Werkzeuge sind separat von `uai-call` registriert.
In der App wird für jedes Werkzeug standardmäßig
`approval_mode = "approve"` verwendet. Bei einer Liste mit bis zu 25
expliziten Vorgängen gilt eine Bestätigung für den gesamten Aufruf.
Eine dauerhaft geänderte Tool-Freigabe ist eine Einstellung des Betreuers
in der App. Die UAI-Betreuerfreigabe und Wiki-Rechte gelten unabhängig davon.


## Vollständiger SWS-Werkzeugumfang

`UAI_ALLOW_SWS_WRITES=1` bietet die benannten Werkzeuge zum Anlegen,
Aktualisieren und Löschen von Entitäten, zum Setzen der Hauptentität und zur
Vergabe von Entitäts-IDs. Konfiguriere dafür in der MCP-App eine Einzelfreigabe
je Aufruf. Der Server gleicht die Eingaben mit der aktuellen Definition im
UAI-Katalog ab. Die Mutationen sind vom lesenden `uai-call` ausgeschlossen.
Die Betreuerfreigabe und MediaWiki-/OAuth-Rechte bleiben erforderlich.

Validierung, Graphabfragen, Suche, Katalog, Entitätsabfragen sowie der
Verarbeitungsstatus standen bereits bereit. Bei installierter SchemaBaseBridge
kommt `swsbase-get-data-view` für eigene, externe und effektive Werte hinzu.
Die statischen SWS-Schreibdefinitionen wurden aus dem UAI-Katalog v1 abgeleitet.
Für übernommene Werkzeugtexte und Eingabedefinitionen siehe LICENSE-CATALOG-MIT.
