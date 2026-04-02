# radio-scrapper

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To scrape the M-1 playlist page as JSON:

```bash
bun run scrape
```

The scraper writes output to `songs.json` by default.

Optional flags:

```bash
bun run scrape -- --page 2 --limit 10 --output songs-page-2.json
```

To sync scraped songs into PostgreSQL, create a `.env` file with:

```bash
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
SPOTIFY_CLIENT_ID=your_spotify_app_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_app_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/callback
SPOTIFY_REFRESH_TOKEN=spotify_refresh_token_with_playlist_modify_scope
SPOTIFY_PLAYLIST_ID=spotify_playlist_id
```

When `DATABASE_URL` is set, the scraper will:

```text
1. Create a `songs` table if it does not exist
2. Insert new songs
3. Store the station name in `radio_station`
4. If a row with the same `radio_station`, title, and artist already exists, add the new `playCount` to the existing `play_count`
5. Load songs from PostgreSQL ordered by highest `play_count`
6. Search those songs on Spotify and replace the target playlist contents in that order
```

The scraper targets https://m-1.15min.lt/grojarastis/ and returns unique songs with station, time, page date, title, artist, and aggregated play count.

Spotify notes:

```text
- The refresh token must belong to a Spotify user who can edit the target playlist
- The token must have playlist modification scope, such as playlist-modify-private or playlist-modify-public
- Songs that are not found on Spotify are skipped
- If Spotify returns 403, rerun `bun run spotify:auth` after updating scopes, then replace the refresh token in `.env`
```

To get a working refresh token from this project:

```bash
bun run spotify:auth
```

Before running it, add the same redirect URI to your Spotify app in the Spotify Developer Dashboard.
The helper starts a local callback server, opens the Spotify consent page, and prints the `SPOTIFY_REFRESH_TOKEN` value to use in `.env`.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
