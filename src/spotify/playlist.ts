import type { SongInfo } from "../types.ts";
import { updateSongSpotifyUri } from "../db/songs.ts";
import { getSpotifyClientFromEnv } from "./client.ts";
import { searchSpotifyTrack } from "./search.ts";
import type { SpotifySyncSummary } from "./types.ts";

export async function syncSpotifyPlaylist(songs: SongInfo[], playlistId: string): Promise<SpotifySyncSummary | null> {
	if (songs.length === 0) {
		return null;
	}

	const client = getSpotifyClientFromEnv();

	if (!client) {
		return null;
	}

	const accessToken = await client.getAccessToken();

	if (!accessToken) {
		return null;
	}

	const skippedSongs: SpotifySyncSummary["skippedSongs"] = [];
	const matchedUris: string[] = [];

	for (const song of songs) {
		if (song.spotifyUri) {
			matchedUris.push(song.spotifyUri);
			continue;
		}

		const spotifyTrack = await searchSpotifyTrack(client, accessToken, song);

		if (!spotifyTrack) {
			skippedSongs.push(song);
			continue;
		}

		matchedUris.push(spotifyTrack.uri);
		await updateSongSpotifyUri(song, {
			spotifyUri: spotifyTrack.uri,
			spotifyTrackName: spotifyTrack.name,
			spotifyArtistName: spotifyTrack.artistNames.join(", "),
		});
	}

	await client.replacePlaylistTracks(accessToken, playlistId, matchedUris);

	return {
		playlistId,
		station: songs[0]?.radioStation ?? "unknown",
		requestedSongs: songs.length,
		matchedSongs: matchedUris.length,
		skippedSongs,
	};
}