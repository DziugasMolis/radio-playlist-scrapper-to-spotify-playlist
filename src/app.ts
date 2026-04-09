import { basename, dirname, extname, join } from "node:path";
import { SONGS_TABLE_NAME, getSongsByStationOrderedByPlayCount, syncSongsToDatabase } from "./db/songs.ts";
import { syncSpotifyPlaylist } from "./spotify/playlist.ts";
import { createRadioStationScraper } from "./stations/index.ts";
import type { RadioStationId, ScrapePayload, SpotifySkippedSongsPayload } from "./types.ts";

const DEFAULT_PLAYLIST_SIZE = 300;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT: number | null = null;
const DEFAULT_OUTPUT_PATH = "songs_";
const DEFAULT_SKIPPED_SONGS_OUTPUT_PATH = "songs_";

type SpotifySkippedSongsOutputMode = "console" | "file" | "none";

function getSpotifySkippedSongsOutputMode(): SpotifySkippedSongsOutputMode {
	const rawValue = Bun.env.SPOTIFY_SKIPPED_SONGS_OUTPUT?.trim().toLowerCase();

	if (!rawValue) {
		return "file";
	}

	if (rawValue === "console" || rawValue === "file" || rawValue === "none") {
		return rawValue;
	}

	throw new Error("SPOTIFY_SKIPPED_SONGS_OUTPUT must be one of: console, file, none.");
}

function getSpotifySkippedSongsOutputPath(outputPath: string): string {
	const extension = extname(outputPath);
	const fileNameWithoutExtension = extension ? basename(outputPath, extension) : basename(outputPath);
	const fileName = extension
		? `${fileNameWithoutExtension}.spotify-not-found${extension}`
		: `${fileNameWithoutExtension}.spotify-not-found.json`;

	return join(dirname(outputPath), fileName);
}

async function runRadioStation(station: RadioStationId): Promise<void> {
	const radioStationScraper = createRadioStationScraper(station);
	const songs = await radioStationScraper.scrapeRadioStationPlaylist(DEFAULT_PAGE);
	const result = DEFAULT_LIMIT === null ? songs : songs.slice(0, DEFAULT_LIMIT);
	const payload: ScrapePayload = {
		source: radioStationScraper.buildPlaylistUrl(DEFAULT_PAGE),
		count: result.length,
		songs: result,
	};
	await Bun.write(DEFAULT_OUTPUT_PATH + radioStationScraper.radioStation + ".json", `${JSON.stringify(payload, null, 2)}\n`);

	const syncedSongsCount = await syncSongsToDatabase(result);

	console.log(`Wrote ${result.length} songs to ${DEFAULT_OUTPUT_PATH + radioStationScraper.radioStation + ".json"}`);

	if (Bun.env.DATABASE_URL?.trim()) {
		console.log(`Synced ${syncedSongsCount} songs to PostgreSQL table ${SONGS_TABLE_NAME}`);
	} else {
		console.log("Skipped PostgreSQL sync because DATABASE_URL is not set");
		return;
	}

	const orderedSongs = await getSongsByStationOrderedByPlayCount(radioStationScraper.radioStation, DEFAULT_PLAYLIST_SIZE);
	try {
		const spotifySyncSummary = await syncSpotifyPlaylist(orderedSongs, radioStationScraper.playlistId);

		if (!spotifySyncSummary) {
			console.log("Skipped Spotify sync because Spotify environment variables are not fully set");
			return;
		}

		console.log(
			`Updated Spotify playlist ${spotifySyncSummary.playlistId} with ${spotifySyncSummary.matchedSongs}/${spotifySyncSummary.requestedSongs} songs for ${spotifySyncSummary.station}`,
		);

		const spotifySkippedSongsOutputPath = getSpotifySkippedSongsOutputPath(DEFAULT_SKIPPED_SONGS_OUTPUT_PATH + radioStationScraper.radioStation + ".json");
		const skippedSongsPayload: SpotifySkippedSongsPayload = {
			playlistId: spotifySyncSummary.playlistId,
			station: spotifySyncSummary.station,
			requestedSongs: spotifySyncSummary.requestedSongs,
			matchedSongs: spotifySyncSummary.matchedSongs,
			skippedCount: spotifySyncSummary.skippedSongs.length,
			songs: spotifySyncSummary.skippedSongs,
		};

		const skippedSongsOutputMode = getSpotifySkippedSongsOutputMode();

		if (skippedSongsOutputMode === "file") {
			await Bun.write(spotifySkippedSongsOutputPath, `${JSON.stringify(skippedSongsPayload, null, 2)}\n`);
			console.log(`Wrote Spotify not-found songs to ${spotifySkippedSongsOutputPath}`);
		} else if (skippedSongsOutputMode === "console") {
			console.log("Spotify not-found songs payload:");
			console.log(JSON.stringify(skippedSongsPayload, null, 2));
		} else {
			console.log("Skipped Spotify not-found songs output because SPOTIFY_SKIPPED_SONGS_OUTPUT=none");
		}

		if (spotifySyncSummary.skippedSongs.length > 0) {
			console.log(
				`Skipped ${spotifySyncSummary.skippedSongs.length} songs that were not found on Spotify`,
			);
		}
	} catch (error) {
		console.error(`Error syncing Spotify playlist for station ${radioStationScraper.radioStation}:`, error);
	}
}

export async function runApp(stations: RadioStationId[] = ["m1", "rc"]): Promise<void> {
	for (const station of stations) {
		await runRadioStation(station);
	}
}