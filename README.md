# InterviewIQ prototype

A locally runnable prototype for behavioral and technical interview practice. It covers session setup, question and follow-up flow, answer capture, mode-specific rubric coaching, session reports, answer revisions, history, and progress trends.

## Run locally

Requirements: Node.js 20+ and Python 3.10+.

1. Copy `.env.example` to `.env`.
2. In your Supabase project, enable email/password authentication. Set the site's URL to `http://127.0.0.1:5187` and add `http://127.0.0.1:5187/**` to allowed redirect URLs.
3. Replace the placeholders in `.env` with the project URL and public anon/publishable key. Never put a service-role key in the frontend or this file.
4. To enable OpenRouter AI coaching, add your key to `OPENROUTER_API_KEY` in `.env` and ensure your OpenRouter account or API key has available credits/budget. The default model is `google/gemini-4-hydrogen`; you can change it with `OPENROUTER_MODEL`. Keep the key only in `.env` on the backend, never in a `VITE_` variable or frontend code. Without a key, InterviewIQ uses local question templates and rule-based coaching.

```powershell
npm install
python -m pip install -r requirements.txt
npm run dev
```

Open the frontend at <http://127.0.0.1:5187>. Both development and production-preview servers use this fixed port and refuse to start if it is occupied, rather than silently showing another project. For a built preview, run `npm run build` then `npm run preview`. The API runs at <http://127.0.0.1:8001>; its interactive documentation is at <http://127.0.0.1:8001/docs>.

Run the API tests with:

```powershell
python -m pytest
```

Create a production frontend bundle with `npm run build`.

## Prototype boundaries

- Supabase handles real email/password account creation, sign-in, email confirmation, and password reset. The API checks each access token with Supabase Auth and scopes profile/session data by authenticated user.
- The API binds to loopback. Profile/session data is stored in `backend/data/interviewiq.sqlite3` on this computer, not in Supabase Postgres.
- If an OpenRouter key is configured, each session can opt in to AI coaching on the setup screen. The selected session sends its role, interview questions, and answer thread to OpenRouter for question generation and feedback; name and profile details are not included. Without opt-in, question templates and feedback run locally. Saved answers remain available to retry if an AI request fails.
- Behavioral and technical sessions use separate questions, follow-ups, rubric dimensions, and rubric versions. Local technical feedback checks answer structure and does not verify whether a solution is technically correct. Progress averages are not combined across interview types.
- Technical practice is text-based: there is no code editor, code execution, or automated test runner. OpenRouter feedback is model-generated guidance and is not independently validated.
- Resume uploads and hosted storage are not included. Scores from either coach are practice guidance only; they are not validated, calibrated, or suitable for hiring decisions.
- The displayed rubric and score weights follow the supplied design documents. Validate the system before any real-world assessment use.

Email confirmation is currently required by the configured Supabase project. For local testing without confirmation, turn off **Authentication → Sign In / Providers → Email → Confirm email** in the Supabase dashboard, then create an account through InterviewIQ. Do not create Auth users or passwords with SQL. For production, configure HTTPS, allowed origins, redirect URLs, retention, and a production database.
