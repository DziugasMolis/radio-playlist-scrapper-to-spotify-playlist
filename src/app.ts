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

function getSpotifySkippedSongsOutputPath(outputPath: string): string {
	const extension = extname(outputPath);
	const fileNameWithoutExtension = extension ? basename(outputPath, extension) : basename(outputPath);
	const fileName = extension
		? `${fileNameWithoutExtension}.spotify-not-found${extension}`
		: `${fileNameWithoutExtension}.spotify-not-found.json`;

	return join(dirname(outputPath), fileName);
}

export async function runApp(): Promise<void> {
	const radioStationScraperList = [createRadioStationScraper("m1"), createRadioStationScraper("rc")];

	for (const radioStationScraper of radioStationScraperList) {
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

			await Bun.write(spotifySkippedSongsOutputPath, `${JSON.stringify(skippedSongsPayload, null, 2)}\n`);

			if (spotifySyncSummary.skippedSongs.length > 0) {
				console.log(
					`Skipped ${spotifySyncSummary.skippedSongs.length} songs that were not found on Spotify`,
				);
			}

			console.log(`Wrote Spotify not-found songs to ${spotifySkippedSongsOutputPath}`);
		} catch (error) {
			console.error(`Error syncing Spotify playlist for station ${radioStationScraper.radioStation}:`, error);
		}
	}
}