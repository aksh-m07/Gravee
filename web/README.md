# Graveyard Shift browser app

Run commands from this `web/` directory using Node **24.15.0**, npm **11.12.1**.
See the [root setup guide](../README.md#run-it) for the demonstration task and caveats.

```bash
npm ci
npm run setup:browser
npm run check
npm run smoke:task
npm run build
npm start -- --hostname 127.0.0.1 --port 3222
```

Open http://127.0.0.1:3222/chat. For development, substitute
`npm run dev -- --hostname 127.0.0.1 --port 3222` for build/start.

`npm run typecheck` runs `next typegen` before TypeScript, including on a fresh checkout.
`npm run test` and `npm run lint` can also run separately. Chromium is installed by
this project's locked Playwright version, with no global browser dependency.

No credentials are needed for checks or the default scripted smoke task. If needed,
copy `.env.example` to `.env.local` **only when `.env.local` does not already exist**,
then add a Gemini key locally. Real environment files are ignored; only the placeholder
example is tracked. Shell environment variables also work.

The optional live check uses one Gemini generation attempt, no retries or fallbacks,
at most 1,536 output tokens and a 30-second timeout:

```bash
npm run smoke:task -- --gemini --model YOUR_AVAILABLE_GEMINI_MODEL_ID
```

Choose a model available to your key that supports minimal thinking
(`gemini-3.6-flash` was verified for this baseline); no model alias is guessed by this command.
It runs the existing guard against a price-wall scenario and checks the observed
record after recovery. The one-attempt cap applies only to this smoke command.
Leave `IMESSAGE_TO` unset to keep outgoing notifications disabled.
