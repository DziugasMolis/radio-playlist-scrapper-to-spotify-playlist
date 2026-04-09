import postgres from "postgres";
import type { SongInfo } from "../types.ts";

export const SONGS_TABLE_NAME = "songs";
export const SPOTIFY_CACHE_TABLE_NAME = "spotify_song_cache";

async function ensureSpotifyCacheTable(sql: postgres.Sql): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS spotify_song_cache (
			id BIGSERIAL PRIMARY KEY,
			title TEXT NOT NULL,
			artist TEXT NOT NULL,
			spotify_uri TEXT NOT NULL,
			spotify_track_name TEXT,
			spotify_artist_name TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS spotify_song_cache_title_artist_unique ON spotify_song_cache (title, artist)`;
}

async function ensureSongsTable(sql: postgres.Sql): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS songs (
			id BIGSERIAL PRIMARY KEY,
			radio_station TEXT NOT NULL DEFAULT 'M1',
			title TEXT NOT NULL,
			artist TEXT NOT NULL,
			page_date TEXT,
			played_time TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS songs_radio_station_title_artist_page_date_played_time_unique
		ON songs (radio_station, title, artist, COALESCE(page_date, ''), played_time)
	`;
	await sql`CREATE INDEX IF NOT EXISTS songs_radio_station_title_artist_idx ON songs (radio_station, title, artist)`;
	await ensureSpotifyCacheTable(sql);
}

export async function syncSongsToDatabase(songs: SongInfo[]): Promise<number> {
	const databaseUrl = Bun.env.DATABASE_URL?.trim();

	if (!databaseUrl) {
		return 0;
	}

	const sql = postgres(databaseUrl, {
		max: 1,
	});

	try {
		await ensureSongsTable(sql);

		for (const song of songs) {
			await sql`
				INSERT INTO songs (radio_station, title, artist, page_date, played_time)
				VALUES (${song.radioStation}, ${song.title}, ${song.artist}, ${song.pageDate}, ${song.time})
				ON CONFLICT DO NOTHING
			`;
		}

		return songs.length;
	} finally {
		await sql.end();
	}
}

export async function getSongsByStationOrderedByPlayCount(radioStation: string, limit: number): Promise<SongInfo[]> {
	const databaseUrl = Bun.env.DATABASE_URL?.trim();

	if (!databaseUrl) {
		return [];
	}

	const sql = postgres(databaseUrl, {
		max: 1,
	});

	try {
		await ensureSongsTable(sql);

		const rows = await sql<{
			radio_station: string;
			title: string;
			artist: string;
			play_count: number;
			spotify_uri: string;
			spotify_track_name: string;
			spotify_artist_name: string;
			page_date: string | null;
			played_time: string | null;
			latest_created_at: string;
		}[]>`
			SELECT
				s.radio_station,
				s.title,
				s.artist,
				COUNT(*)::INTEGER AS play_count,
				c.spotify_uri,
				c.spotify_track_name,
				c.spotify_artist_name,
				MAX(s.page_date) AS page_date,
				MAX(s.played_time) AS played_time,
				MAX(s.created_at)::TEXT AS latest_created_at
			FROM songs s
			LEFT JOIN spotify_song_cache c
				ON c.title = s.title
				AND c.artist = s.artist
			WHERE radio_station = ${radioStation}
			GROUP BY s.radio_station, s.title, s.artist, c.spotify_uri, c.spotify_track_name, c.spotify_artist_name
			ORDER BY play_count DESC, latest_created_at DESC, played_time DESC NULLS LAST, title ASC
			LIMIT ${limit}
		`;

		return rows.map((row) => ({
			radioStation: row.radio_station,
			title: row.title,
			artist: row.artist,
			playCount: row.play_count,
			spotifyUri: row.spotify_uri,
			spotifyTrackName: row.spotify_track_name,
			spotifyArtistName: row.spotify_artist_name,
			pageDate: row.page_date,
			time: row.played_time ?? "",
		}));
	} finally {
		await sql.end();
	}
}

export async function updateSongSpotifyUri(
	song: Pick<SongInfo, "radioStation" | "title" | "artist">,
	spotifyMatch: Pick<SongInfo, "spotifyUri" | "spotifyTrackName" | "spotifyArtistName">,
): Promise<void> {
	const databaseUrl = Bun.env.DATABASE_URL?.trim();

	if (!databaseUrl) {
		return;
	}

	const sql = postgres(databaseUrl, {
		max: 1,
	});

	try {
		await ensureSongsTable(sql);
		await sql`
			INSERT INTO spotify_song_cache (title, artist, spotify_uri, spotify_track_name, spotify_artist_name)
			VALUES (${song.title}, ${song.artist}, ${spotifyMatch.spotifyUri}, ${spotifyMatch.spotifyTrackName}, ${spotifyMatch.spotifyArtistName})
			ON CONFLICT (title, artist)
			DO UPDATE
			SET
				spotify_uri = EXCLUDED.spotify_uri,
				spotify_track_name = EXCLUDED.spotify_track_name,
				spotify_artist_name = EXCLUDED.spotify_artist_name,
				updated_at = NOW()
		`;
	} finally {
		await sql.end();
	}
}