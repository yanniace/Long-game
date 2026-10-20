# The Long Game

The dashboard runs in two modes from the same source file:

- **Mac:** `phd_bridge.py` serves `phd_dashboard.html` at `http://localhost:8000`, preserves `localStorage`, and mirrors saves to the untracked local `data.json`.
- **iPhone / browser:** GitHub Pages deploys `phd_dashboard.html` as `index.html`. Supabase provides email/password authentication and one RLS-protected `tlg_state` JSONB row per user.

## Data safety

`data.json`, backup JSON files, `.env` files, and local/private directories are ignored by Git. Never force-add them. The first cloud upload is deliberately manual:

1. Sign in on the populated Mac.
2. Open **Local only** in the header.
3. Choose **Upload this device** and review the record counts in the confirmation.
4. Only after that succeeds, sign in on an empty iPhone. The empty iPhone downloads the populated cloud state; it cannot automatically overwrite it.

When both local and cloud copies contain data on an unlinked device, the dashboard reports **Conflict / newer cloud version** and requires a direction choice.

## Supabase setup

1. Create a Supabase project and enable email/password authentication.
2. Run [`supabase/migrations/001_tlg_state.sql`](supabase/migrations/001_tlg_state.sql) in the SQL editor.
3. For localhost, copy `config.example.js` to the ignored `config.js` and enter only the Project URL and browser-safe publishable key.
4. Add the GitHub repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Do not add a service-role or secret key.
5. In Supabase Authentication URL Configuration, add the localhost URL and final GitHub Pages URL to the allowed redirect URLs.

## GitHub Pages

The Actions workflow builds a static artifact without committing `config.js`. In repository **Settings → Pages**, choose **GitHub Actions** as the source. A push to `main` deploys the site.

On iPhone, open the Pages URL in Safari, use **Share → Add to Home Screen**, and launch The Long Game from the new icon.

## Local launch

Run `./start.command` or `python3 phd_bridge.py`. The bridge binds only to localhost. Existing wrappers such as `TLG.app` can continue launching the same command/URL.

