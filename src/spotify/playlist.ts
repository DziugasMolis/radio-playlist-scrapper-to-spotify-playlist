import type { SongInfo } from "../types.ts";

const SPOTIFY_ACCOUNTS_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";
const SPOTIFY_TRACKS_PER_REQUEST = 100;
const SPOTIFY_MAX_RATE_LIMIT_RETRIES = 5;

type SpotifyTrackSearchResult = {
	uri: string;
	name: string;
	artistNames: string[];
};

type SpotifySyncSummary = {
	playlistId: string;
	station: string;
	requestedSongs: number;
	matchedSongs: number;
	skippedSongs: Array<{
		title: string;
		artist: string;
	}>;
};

function getSpotifyConfig() {
	const clientId = Bun.env.SPOTIFY_CLIENT_ID?.trim();
	const clientSecret = Bun.env.SPOTIFY_CLIENT_SECRET?.trim();
	const refreshToken = Bun.env.SPOTIFY_REFRESH_TOKEN?.trim();
	const playlistId = Bun.env.SPOTIFY_PLAYLIST_ID?.trim();

	if (!clientId || !clientSecret || !refreshToken || !playlistId) {
		return null;
	}

	return {
		clientId,
		clientSecret,
		refreshToken,
		playlistId,
	};
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getRetryDelayMilliseconds(response: Response, attempt: number): number {
	const retryAfterHeader = response.headers.get("retry-after");

	if (retryAfterHeader) {
		const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
		if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
			return retryAfterSeconds * 1000;
		}
	}

	return Math.min(1000 * 2 ** attempt, 15000);
}

async function getSpotifyAccessToken(): Promise<string | null> {
	const config = getSpotifyConfig();

	if (!config) {
		return null;
	}

	const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: config.refreshToken,
	});

	const response = await fetch(SPOTIFY_ACCOUNTS_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${basicAuth}`,
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});

	if (!response.ok) {
		throw new Error(`Failed to get Spotify access token: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as { access_token?: string };
	return data.access_token ?? null;
}

async function searchSpotifyTrack(accessToken: string, song: SongInfo): Promise<SpotifyTrackSearchResult | null> {
	const query = new URLSearchParams({
		q: `track:${song.title} artist:${song.artist}`,
		type: "track",
		limit: "1",
	});

	for (let attempt = 0; attempt <= SPOTIFY_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
		const response = await fetch(`${SPOTIFY_API_BASE_URL}/search?${query.toString()}`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (response.status === 429) {
			if (attempt === SPOTIFY_MAX_RATE_LIMIT_RETRIES) {
				throw new Error(`Spotify track search failed for ${song.title} - ${song.artist}: 429 Too Many Requests`);
			}

			await sleep(getRetryDelayMilliseconds(response, attempt));
			continue;
		}

		if (!response.ok) {
			throw new Error(`Spotify track search failed for ${song.title} - ${song.artist}: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as {
			tracks?: {
				items?: Array<{
					uri: string;
					name: string;
					artists: Array<{ name: string }>;
				}>;
			};
		};

		const firstTrack = data.tracks?.items?.[0];

		if (!firstTrack) {
			return null;
		}

		return {
			uri: firstTrack.uri,
			name: firstTrack.name,
			artistNames: firstTrack.artists.map((artist) => artist.name),
		};
	}

	throw new Error(`Spotify track search failed for ${song.title} - ${song.artist}: retry limit exceeded`);
}

async function replaceSpotifyPlaylistTracks(accessToken: string, playlistId: string, uris: string[]): Promise<void> {
	const clearResponse = await fetch(`${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ uris: [] }),
	});

	if (!clearResponse.ok) {
		const errorBody = await clearResponse.text();
		throw new Error(
			`Failed to clear Spotify playlist tracks: ${clearResponse.status} ${clearResponse.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
		);
	}

	for (let index = 0; index < uris.length; index += SPOTIFY_TRACKS_PER_REQUEST) {
		const chunk = uris.slice(index, index + SPOTIFY_TRACKS_PER_REQUEST);

		const addResponse = await fetch(`${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/tracks`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ uris: chunk }),
		});

		if (!addResponse.ok) {
			const errorBody = await addResponse.text();
			throw new Error(
				`Failed to append Spotify playlist tracks: ${addResponse.status} ${addResponse.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
			);
		}
	}
}

export async function syncSpotifyPlaylist(songs: SongInfo[]): Promise<SpotifySyncSummary | null> {
	if (songs.length === 0) {
		return null;
	}

	const config = getSpotifyConfig();

	if (!config) {
		return null;
	}

	const accessToken = await getSpotifyAccessToken();

	if (!accessToken) {
		return null;
	}

	const skippedSongs: SpotifySyncSummary["skippedSongs"] = [];
	const matchedUris: string[] = [];

	for (const song of songs) {
		const spotifyTrack = await searchSpotifyTrack(accessToken, song);

		if (!spotifyTrack) {
			skippedSongs.push({
				title: song.title,
				artist: song.artist,
			});
			continue;
		}

		matchedUris.push(spotifyTrack.uri);
	}

	await replaceSpotifyPlaylistTracks(accessToken, config.playlistId, matchedUris);

	return {
		playlistId: config.playlistId,
		station: songs[0]?.radioStation ?? "unknown",
		requestedSongs: songs.length,
		matchedSongs: matchedUris.length,
		skippedSongs,
	};
}