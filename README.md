# MVVC Coach Copilot (MVP)

A small, private, coach-facing web app:
- Coaches log in (Supabase)
- Pick a team + season
- Ask questions in chat
- Answers are grounded in *your precomputed metrics* (not invented by the model)
- The model uses OpenAI **Responses API**.

## 0) Prereqs
- Node 18+
- Supabase project (free tier is fine)
- OpenAI API key

## 1) Create Supabase tables
Open Supabase SQL Editor and run:
- `supabase/schema.sql`

## 2) Configure env vars
Copy `.env.example` -> `.env.local` and fill:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`

## 3) Load your data (MVP)
This MVP expects you to load:
- `knowledge_chunks` rows (markdown/text chunks with tags + season/team)
- `player_metrics` rows (precomputed metrics like pass_rating, receive_ta, error_rates, etc.)

See `scripts/load_example_data.sql` for the format.

## 4) Run locally
```bash
npm install
npm run dev
```
Open http://localhost:3000

## 5) Deploy
- Vercel recommended: set the same env vars in Vercel project settings.
- Supabase stays as the DB + Auth provider.

## How it answers questions (important)
The app:
1) Retrieves relevant `knowledge_chunks` and `player_metrics` using Postgres full-text search + filters.
2) Sends ONLY those retrieved facts + your question to the model.
3) The model is instructed to cite the provided facts and to say "Insufficient data" if needed.

That’s how you keep coaches' trust.
