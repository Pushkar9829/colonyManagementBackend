# ColonyHub API (backend)

REST API (`/api/v1`) for ColonyHub, a multi-tenant app for residential societies and gated communities: gate and
visitors, daily help, SOS, maintenance billing and payments, helpdesk, notices, polls, amenities, accounting,
staff HR, governance and more. The web app lives in a separate repo, **colonyManagementFrontEnd**.

Stack: Node.js 20+, Express 4, MongoDB (Mongoose 9), Zod, JWT, Socket.IO. No Redis or other services needed.

## Run locally

Needs Node.js 20+ and MongoDB on `mongodb://127.0.0.1:27017`.

```bash
cp .env.example .env        # set JWT_ACCESS_SECRET to a long random string
npm install
npm run seed                # demo society "Green Valley Residency", join code DEMO01
npm run dev                 # http://localhost:5000/api/v1/health
```

Demo logins (password `Password@123`): `admin@demo.test`, `accountant@demo.test`, `manager@demo.test`,
`guard@demo.test`, `plumber@demo.test`, `resident@demo.test`, `neha@demo.test`, `superadmin@demo.test`.

Tests (throwaway `colony_management_test` database): `npm test`

## Deploy on Render (demo)

1. MongoDB Atlas → Network Access: allow `0.0.0.0/0`.
2. Render → New → **Blueprint** → this repo. `render.yaml` sets everything and asks only for `MONGODB_URI`, e.g.
   `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/colony_management?retryWrites=true&w=majority`
3. Check `https://<service>.onrender.com/api/v1/health` returns `"db":"up"`.

The demo blueprint uses no paid services: mock payments, messages printed to the log, uploads on the server disk,
`CORS_ORIGINS=*` (any site may call the API; it uses bearer tokens, not cookies) and `DEMO_MODE=true` (login codes and
reset links shown on screen, indexes built on start-up).

Load demo data into a new database from your machine (with `MONGODB_URI` pointing at it):

```bash
npm run db:indexes
npm run seed -- --reset
```

For a real society, switch to real providers (Razorpay, Twilio, SendGrid, WhatsApp Cloud API, Cloudinary, web push)
and turn `DEMO_MODE` off — every variable is listed in `.env.example`.
