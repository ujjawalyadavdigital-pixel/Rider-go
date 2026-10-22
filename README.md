# RiderGo

Delivery partner app: a web UI (`app/www`), a REST API with SQLite (`backend`), and an Android wrapper (`app/android`).

## Run the backend + web app
```
cd backend && npm install && npm start      # http://localhost:3000 (serves the app too)
npm test                                    # 5 end-to-end API tests
```
Needs Node 22.13 or newer (uses the built-in `node:sqlite`, no native modules).

Environment: `PORT` (3000), `DB_FILE` (./data/ridergo.db), `DEMO_MODE` (1).
**Demo mode** returns login OTPs and the pickup/delivery codes in API responses so you can click through the flow.
Set `DEMO_MODE=0` before real use, and plug an SMS provider into `POST /api/auth/send-otp`.
Docs are auto-verified 1.5 s after upload in demo; replace with a real review step.
Orders are generated for online riders in demo; replace `GET /api/orders/offer` with your dispatch service.

## Build the APK
**Option A, no setup (GitHub):** push this folder to a GitHub repo, open Actions → "Build Android APK" → Run workflow. Download `RiderGo-debug-apk` from the run.

**Option B, locally:** install JDK 21 and Android Studio (or the Android SDK), then
```
cd app && npm install && npx cap sync android
cd android && ./gradlew assembleDebug
# → app/android/app/build/outputs/apk/debug/app-debug.apk
```
Before building, set your server in `app/www/config.js` (`window.RIDERGO_API = "https://your-api"`).
Riders can also change it from the login screen ("Server: …"). Emulator → host machine is `http://10.0.2.2:3000`.
Debug APKs are for testing. For the Play Store, create a keystore and build a signed release (`assembleRelease`).

## API (all under /api, JSON, Bearer token)
| Method | Path | Purpose |
|---|---|---|
| POST | /auth/send-otp, /auth/verify-otp, /auth/logout | Login |
| GET/PUT | /me | Profile |
| GET | /documents · POST /documents/:type · POST /profile/submit | Verification |
| GET | /dashboard · POST /status | Home, go online/offline |
| GET | /orders/offer · GET /orders/active | Dispatch + resume |
| POST | /orders/:id/accept, decline, arrive, verify-pickup, pickup, reached, contact, deliver, settle | Order lifecycle |
| GET | /orders/:id/earnings · GET /earnings?range=today\|week | Earnings |
| POST | /shift/end | End shift summary |
