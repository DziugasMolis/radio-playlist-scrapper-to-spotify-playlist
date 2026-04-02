import postgres from "postgres";
import type { SongInfo } from "../types.ts";

export const SONGS_TABLE_NAME = "songs";

async function ensureSongsTable(sql: postgres.Sql): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS songs (
			id BIGSERIAL PRIMARY KEY,
			radio_station TEXT NOT NULL DEFAULT 'M1',
			title TEXT NOT NULL,
			artist TEXT NOT NULL,
			play_count INTEGER NOT NULL DEFAULT 0,
			page_date TEXT,
			last_played_time TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS songs_radio_station_title_artist_unique ON songs (radio_station, title, artist)`;
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
				INSERT INTO songs (radio_station, title, artist, play_count, page_date, last_played_time)
				VALUES (${song.radioStation}, ${song.title}, ${song.artist}, ${song.playCount}, ${song.pageDate}, ${song.time})
				ON CONFLICT (radio_station, title, artist)
				DO UPDATE
				SET
					play_count = songs.play_count + EXCLUDED.play_count,
					radio_station = EXCLUDED.radio_station,
					page_date = EXCLUDED.page_date,
					last_played_time = EXCLUDED.last_played_time,
					updated_at = NOW()
			`;
		}

		return songs.length;
	} finally {
		await sql.end();
	}
}

export async function getSongsByStationOrderedByPlayCount(radioStation: string): Promise<SongInfo[]> {
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
			page_date: string | null;
			last_played_time: string | null;
		}[]>`
			SELECT radio_station, title, artist, play_count, page_date, last_played_time
			FROM songs
			WHERE radio_station = ${radioStation}
			ORDER BY play_count DESC, last_played_time DESC NULLS LAST, title ASC
		`;

		return rows.map((row) => ({
			radioStation: row.radio_station,
			title: row.title,
			artist: row.artist,
			playCount: row.play_count,
			pageDate: row.page_date,
			time: row.last_played_time ?? "",
		}));
	} finally {
		await sql.end();
	}
}