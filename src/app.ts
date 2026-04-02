import { parseCliOptions } from "./cli.ts";
import { SONGS_TABLE_NAME, getSongsByStationOrderedByPlayCount, syncSongsToDatabase } from "./db/songs.ts";
import { syncSpotifyPlaylist } from "./spotify/playlist.ts";
import { buildM1PlaylistUrl, scrapeM1Playlist } from "./stations/m1.ts";
import type { ScrapePayload } from "./types.ts";

export async function runApp(argv: string[]): Promise<void> {
	const options = parseCliOptions(argv);
	const songs = await scrapeM1Playlist(options.page);
	const result = options.limit === null ? songs : songs.slice(0, options.limit);
	const payload: ScrapePayload = {
		source: buildM1PlaylistUrl(options.page),
		count: result.length,
		songs: result,
	};

	await Bun.write(options.output, `${JSON.stringify(payload, null, 2)}\n`);

	const syncedSongsCount = await syncSongsToDatabase(result);

	console.log(`Wrote ${result.length} songs to ${options.output}`);

	if (Bun.env.DATABASE_URL?.trim()) {
		console.log(`Synced ${syncedSongsCount} songs to PostgreSQL table ${SONGS_TABLE_NAME}`);
	} else {
		console.log("Skipped PostgreSQL sync because DATABASE_URL is not set");
		return;
	}

	const radioStation = result[0]?.radioStation;

	if (!radioStation) {
		return;
	}

	const orderedSongs = await getSongsByStationOrderedByPlayCount(radioStation);
	const spotifySyncSummary = await syncSpotifyPlaylist(orderedSongs);

	if (!spotifySyncSummary) {
		console.log("Skipped Spotify sync because Spotify environment variables are not fully set");
		return;
	}

	console.log(
		`Updated Spotify playlist ${spotifySyncSummary.playlistId} with ${spotifySyncSummary.matchedSongs}/${spotifySyncSummary.requestedSongs} songs for ${spotifySyncSummary.station}`,
	);

	if (spotifySyncSummary.skippedSongs.length > 0) {
		console.log(
			`Skipped ${spotifySyncSummary.skippedSongs.length} songs that were not found on Spotify`,
		);
	}
}