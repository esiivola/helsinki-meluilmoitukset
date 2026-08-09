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

Ympäristönsuojelulaki nimeää ilmoitusvelvollisen toiminnan kahtena ryhmänä,
rakentamisena ja yleisötilaisuutena, ja aineisto tukee tätä jakoa. Arkiston 1485
päätöksestä vain kaksi sopisi molempiin ryhmiin, joten hienojakoisempi luokittelu
loisi eroja, joita aineistossa ei ole.

| Tyyppi | Osuus |
| --- | --- |
| Yleisötilaisuudet | 261 |
| Rakentaminen | 1220 |
| Muu toiminta | 3 |

Ilmoitus luokitellaan päätöksen otsikossa kuvatun toiminnan perusteella. Osoiteosa
jätetään huomiotta, koska paikannimet menevät muuten toiminnan kuvauksen edelle:
Katajanokanlaiturilla pidetty ulkoilmakonsertti ei ole laiturin rakentamista.

Kartan värit ovat liuskeensininen, okra ja lämmin harmaa. Ne on valittu tarkoituksella
ilman liikennevalomerkitystä: konsertti ei ole hyvä eikä purkutyömaa paha, ne ovat eri
toimintaa. Kartan alalaidan selite toimii samalla suodattimena.

### Vahdit

Vahti on alue, jonka rajaat kartalle, ja valinnaisesti joukko melun tyyppejä. Kun alueelle
tulee uusi meluilmoitus, vahti kertoo siitä seuraavalla käyntikerralla. Ilmoitukset
säilyvät, kunnes kuittaat ne itse, joko yksitellen, vahdeittain tai kaikki kerralla.

Vahdin nimeä ja seurattavia tyyppejä voi muokata jälkikäteen. Aluetta ei muokata, vaan
uusi alue tehdään uutena vahtina.

Vahdit tallentuvat selaimen localStorage-muistiin. Palvelu on staattinen sivusto, jolla ei
ole palvelinta, joka voisi ottaa tietoja vastaan.

### Sijainnin päättely

Sijainti luetaan päätöksen otsikosta neljällä säännöllä, jotka etenevät tarkimmasta
karkeimpaan: katuosoite numeroineen, kahden kadun risteys, nimetty katu tai paikka, ja
lopuksi kaupunginosa. Jos mikään ei osu, nimi yritetään vielä tunnistaa osana pidempää
rekisterinimeä: yhdyssanan alkuosana (Stansvikinkalliolla tunnistetaan Stansvikiksi) tai
useamman nimen yhteisenä loppuosana (Esplanadi on Pohjois-, Etelä-, Kappeli- ja
Teatteriesplanadin yhteinen loppu). Jälkimmäinen hyväksytään vain, jos nimet ovat samassa
paikassa; kaupungin laajuisesti hajallaan oleva loppuosa, kuten "puisto", hylätään.

Suomen taivutus tuotetaan rekisterinimistä eikä arvata: sekä pääte- että
paikallissijamuodot, ja astevaihtelu (Kamppi on Kampissa, Katajanokka on Katajanokan).
Näin 1484 päätöksestä 1481 saa sijainnin.

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
