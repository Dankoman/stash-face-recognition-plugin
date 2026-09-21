# Installation

## Server

Kör Stash och StashAPI. API:t behöver befintliga ONNX-modeller och exporterad KNN-data. Träning och modelluppdateringar hör till servern, inte webbläsarpluginet.

Konfigurera en `/face-api/`-väg under Stashs befintliga HTTPS-proxy, med vidarebefordran till Go-tjänsten. Vägen ska kontrollera Stash-inloggningen innan anropet skickas vidare. Ett exempel för den aktuella installationen finns i StashAPI-repot under `deployment/nginx-face-api.conf`.

Anonyma anrop till `/face-api/api/health` ska få 401. Med Stash-inloggning ska svaret vara 200 och `model_loaded: true`. API 1.9 returnerar 503 om analysmotorn inte är redo.

Spara API-nycklar i en skyddad serverfil, exempelvis `/var/lib/stashapi/metadata.env` med rättighet 0600, och ange den som tjänstens `EnvironmentFile`:

```dotenv
STASH_API_KEY="..."
STASHDB_API_KEY="..."
TPDB_API_KEY="..."
PMVSTASH_API_KEY="..."
FANSDB_API_KEY="..."
```

Behåll dina faktiska värden; lägg inte filen i Git eller Nix-källkoden. Starta om API-tjänsten efter ändring.

## Plugin

1. Säkerhetskopiera de tre befintliga pluginfilerna och pluginets inställningar.
2. Lägg JS-, CSS- och YAML-filerna från ZIP-paketet i Stashs pluginskatalog.
3. Ladda om plugins i Stash och ladda om webbsidan.
4. Sätt **API URL** till `/face-api`.
5. Högerklicka på **Identifiera** och välj **Testa anslutning**.

Vid uppgradering från 2.3: flytta först metadata-nycklarna från plugininställningarna till API-tjänsten och verifiera att servern läst dem. Därefter kan de gamla nyckelfälten tömmas. Plugin 2.4 använder inte dessa fält. Övriga inställningar ska bevaras.

## Felsökning

- **401:** Stash-sessionen saknas eller har gått ut. Logga in igen.
- **502:** Nginx når inte Go-tjänsten.
- **503 / modellen inte laddad:** läs loggen för `stashapi.service` och kontrollera modellfilerna.
- **Timeout:** kontrollera API-tjänstens logg och belastning. Öka timeout vid behov.
- **Inga ansikten:** API:t svarade med en tom lista; välj en annan bildruta.

Återställ gamla pluginfiler och inställningar från samma backup om en uppdatering behöver backas.
