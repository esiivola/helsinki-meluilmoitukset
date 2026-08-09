# Helsingin meluilmoituskartta

Karttapalvelu Helsingin meluilmoituspäätösten selaamiseen. Näyttää valitulta ajanjaksolta,
missä kaupungissa tehdään erityisen häiritsevää melua aiheuttavaa työtä ja missä
järjestetään meluavia ulkoilmatilaisuuksia.

**[Avaa meluilmoituskartta](https://esiivola.github.io/helsinki-meluilmoitukset/)**

Meluilmoitus on ympäristönsuojelulain 118 §:n mukainen ilmoitus tilapäisestä toiminnasta,
joka aiheuttaa erityisen häiritsevää melua tai tärinää. Helsingissä ilmoituksen käsittelee
kaupunkiympäristön toimialan ympäristönsuojelu, joka antaa päätöksessä toimintaa koskevat
määräykset.

## Mitä palvelu näyttää

- Meluilmoituspäätökset kartalla valitulle ajanjaksolle, oletuksena seuraavat 7 vuorokautta
- Pikavalinnat ajanjaksolle: tänään, 7 vuorokautta, 30 vuorokautta ja tämä vuosi, sekä oma ajanjakso
- Saman kohteen kaikki ilmoitukset yhtenä listana
- Voimassaoloaika, päätöksen sallima työaika ja ilmoittaja
- Suora linkki alkuperäiseen päätökseen
- Rajaus melun tyypin mukaan, suomen- ja englanninkielinen käyttöliittymä

### Melun tyypit

Ilmoitus luokitellaan päätöksen otsikossa kuvatun toiminnan perusteella. Sama ilmoitus voi
kuulua useaan tyyppiin, sillä noin neljännes päätöksistä sallii monta eri melutyyppiä.
Siksi tyyppien lukumäärien summa on suurempi kuin ilmoitusten määrä.

Louhinta ja räjäytys · Murskaus ja iskuvasarointi · Paalutus ja pontitus · Poraus ·
Purku ja saneeraus · Rata- ja kiskotyöt · Vesirakentaminen · Maa- ja katutyöt ·
Ulkoilmakonsertit ja yleisötilaisuudet · Muu toiminta

Kartalla merkin väri kertoo ilmoituksen määräävimmän tyypin. Kaikki tyypit näkyvät
ilmoituksen tiedoissa.

### Vahdit

Vahti on alue, jonka rajaat kartalle, ja valinnaisesti joukko melun tyyppejä. Kun alueelle
tulee uusi meluilmoitus, vahti kertoo siitä seuraavalla käyntikerralla. Ilmoitukset
säilyvät, kunnes kuittaat ne itse, joko yksitellen, vahdeittain tai kaikki kerralla.

Vahdit tallentuvat selaimen localStorage-muistiin. Palvelu on staattinen sivusto, jolla ei
ole palvelinta, joka voisi ottaa tietoja vastaan.

Tiedot on poimittu automaattisesti päätösteksteistä. Ajanjaksot, työajat ja sijainnit
voivat olla epätarkkoja. Alkuperäinen päätös ratkaisee.

## Miten se toimii

Palvelussa on kaksi osaa.

**Kerääjä** (`scripts/`) hakee meluilmoituspäätökset Helsingin kaupungin päätöshaun
avoimesta hakurajapinnasta, poimii teksteistä ajanjakson, työajat, ilmoittajan ja melun
tyypit sekä paikantaa kohteen kaupungin avoimista osoite-, nimistö- ja aluerekistereistä.
Tulos kirjoitetaan arkistoon (`data/decisions.json`) ja julkaistaan selaimelle vuosittain
paloiteltuna (`public/data/`).

**Karttasovellus** (`src/`) lukee vain valmiit JSON-tiedostot. Käynnistyessään se lataa
hakemiston ja kuluvan jakson. Menneiden vuosien palat haetaan vasta, jos käyttäjä selaa
niihin. Sovelluksella ei ole ajonaikaista rajapintariippuvuutta.

GitHub Actions ajaa kerääjän päivittäin ja nimistön uudelleenrakennuksen kuukausittain.
Päivittäinen ajo tuottaa aina commitin, mikä pitää ajastetun työnkulun aktiivisena. GitHub
poistaa ajastukset käytöstä julkisessa repositoriossa 60 päivän käyttämättömyyden jälkeen.

## Tietolähteet

- [Helsingin kaupungin päätökset](https://paatokset.hel.fi/): meluilmoituspäätökset
- Helsingin kaupungin avoin paikkatieto (WFS): osoiteluettelo, nimistö sekä kaupunginosa-
  ja osa-aluejako
- Taustakartta: OpenStreetMap ja CARTO

## Paikallinen kehitys

Edellytyksenä on Node.js 22.

```bash
npm ci
npm run dev
```

Testit ja tuotantoversio:

```bash
npm test
npm run build
```

Aineiston päivitys käsin:

```bash
npm run gazetteer && npm run collect
```

Koko arkiston uudelleenluku:

```bash
node scripts/update-noise-data.mjs --backfill
```

`main`-haaraan viedyt muutokset testataan, rakennetaan ja julkaistaan automaattisesti
GitHub Pagesiin.

## Tekijä

[Eero Siivola](https://esiivola.github.io/)
