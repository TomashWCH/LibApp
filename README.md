# Podsumowanie dnia — Librus (+ docelowo WhatsApp)

Etap 1 i 2: szkielet PWA + moduł Librusa z automatyczną, codzienną synchronizacją
przez GitHub Actions i streszczeniem przez Gemini. Zero kosztów, zero karty płatniczej.

## Jak to działa

```
GitHub Actions (codziennie rano)
   -> loguje się do Librusa (dla Ciebie i żony osobno)
   -> wysyła dane do Gemini -> dostaje zwięzłe podsumowanie PL + wykryte terminy
   -> zapisuje wynik do Firestore
Appka (PWA, Firebase Hosting)
   -> logowanie przez Google
   -> na żywo odczytuje podsumowanie z Firestore (bez czekania, bo sync już się odbył)
```

## Konfiguracja krok po kroku

### 1. Firebase (bez karty)
1. Wejdź na https://console.firebase.google.com -> **Dodaj projekt**.
2. W projekcie włącz:
   - **Authentication** -> Sign-in method -> włącz **Google**
   - **Firestore Database** -> Utwórz bazę (tryb produkcyjny)
3. **Ustawienia projektu -> Twoje aplikacje -> Dodaj aplikację (Web)** — skopiuj wygenerowany
   `firebaseConfig` i wklej go w `public/index.html` (sekcja `TODO: podmień...`).
4. **Ustawienia projektu -> Konta usługi -> Generuj nowy klucz prywatny** — pobierze się
   plik JSON. Jego CAŁĄ zawartość wkleisz jako sekret `FIREBASE_SERVICE_ACCOUNT` (patrz pkt 4).

### 2. Gemini (bez karty)
1. Wejdź na https://aistudio.google.com/app/apikey
2. Wygeneruj klucz API — to jest Twój `GEMINI_API_KEY`.

### 3. Deploy appki (Firebase Hosting)
```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # wybierz istniejący projekt, katalog publiczny: public
firebase deploy
```
Po deployu appka będzie dostępna pod adresem `https://TWOJ_PROJEKT.web.app` — tam
zaloguj się Ty i żona (osobno, przez Google).

### 4. Uzupełnienie UID użytkowników
Po pierwszym zalogowaniu się w appce:
1. Firebase Console -> Authentication -> Users — skopiuj UID Twojego konta i żony.
2. Wklej je do `scripts/users.config.json` w pola `firestoreUid`.

### 5. Sekrety GitHub Actions
W repozytorium na GitHubie: **Settings -> Secrets and variables -> Actions -> New repository secret**.
Dodaj:

| Nazwa sekretu | Wartość |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | cała zawartość pliku JSON z kroku 1.4 |
| `GEMINI_API_KEY` | klucz z kroku 2 |
| `LIBRUS_LOGIN_TOMEK` | Twój login do Librusa |
| `LIBRUS_PASSWORD_TOMEK` | Twoje hasło do Librusa |
| `LIBRUS_LOGIN_ZONA` | login żony do Librusa |
| `LIBRUS_PASSWORD_ZONA` | hasło żony do Librusa |

### 6. Pierwsze uruchomienie
Zakładka **Actions** w repo -> workflow "Codzienna synchronizacja Librus" ->
**Run workflow** (ręczne uruchomienie, nie trzeba czekać do rana).
Sprawdź logi — jeśli wszystko OK, w appce powinno pojawić się podsumowanie.

Harmonogram jest ustawiony na 5:30 UTC (ok. 6:30–7:30 czasu polskiego) —
możesz to zmienić w `.github/workflows/sync.yml` (pole `cron`).

## Co dalej (kolejne moduły, jeszcze niezrobione)
- **Google Calendar** — przycisk "Dodaj" przy wykrytych terminach na razie tylko
  pokazuje alert; podłączenie prawdziwego zapisu do kalendarza to kolejny krok.
- **WhatsApp** — najbardziej ryzykowny i pracochłonny moduł, celowo zostawiony na koniec.

## Bezpieczeństwo
- Loginy/hasła do Librusa nigdy nie trafiają do appki ani do repozytorium — żyją
  wyłącznie jako zaszyfrowane sekrety GitHub Actions.
- Firestore ma reguły ograniczające każdemu użytkownikowi dostęp tylko do własnych danych
  (`firestore.rules`) — wdróż je przez `firebase deploy --only firestore:rules`.
