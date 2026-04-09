import type { SongInfo } from "../types.ts";
import { updateSongSpotifyUri } from "../db/songs.ts";

const SPOTIFY_ACCOUNTS_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";
const SPOTIFY_MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_SPOTIFY_REQUESTS_PER_MINUTE = 60;
const SPOTIFY_PLAYLIST_ITEMS_PAGE_SIZE = 100;

let spotifyRequestQueue = Promise.resolve();
let lastSpotifyRequestStartedAt = 0;

type SpotifyTrackSearchResult = {
	uri: string;
	name: string;
	artistNames: string[];
};

type SpotifyTrackItem = {
	uri: string;
	name: string;
	artists: Array<{ name: string }>;
};

type SpotifyTitleMatch = {
	score: number;
	hasMatch: boolean;
	matchRatio: number;
	matchType:
		| "exact"
		| "simplified-exact"
		| "metadata-stripped-exact"
		| "delimiter-part-exact"
		| "full-token-overlap"
		| "strong-token-overlap"
		| "prefix"
		| "substring"
		| "none";
};

type SpotifyCurrentUser = {
	id: string;
	display_name?: string;
};

type SpotifyPlaylistDetails = {
	id: string;
	name?: string;
	public?: boolean;
	collaborative?: boolean;
	owner?: {
		id?: string;
		display_name?: string;
	};
};

type SpotifyPlaylistItemPage = {
	total: number;
	items: Array<{
		item?: { uri?: string | null } | null;
	}>;
};

type SpotifySyncSummary = {
	playlistId: string;
	station: string;
	requestedSongs: number;
	matchedSongs: number;
	skippedSongs: SongInfo[];
};

function getSpotifyConfig() {
	const clientId = Bun.env.SPOTIFY_CLIENT_ID?.trim();
	const clientSecret = Bun.env.SPOTIFY_CLIENT_SECRET?.trim();
	const refreshToken = Bun.env.SPOTIFY_REFRESH_TOKEN?.trim();
	const playlistIdM1 = Bun.env.SPOTIFY_PLAYLIST_ID_M1?.trim();

	if (!clientId || !clientSecret || !refreshToken || !playlistIdM1) {
		return null;
	}

	return {
		clientId,
		clientSecret,
		refreshToken,
		playlistIdM1,
	};
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getSpotifyRequestsPerMinute(): number {
	const rawValue = Bun.env.SPOTIFY_REQUESTS_PER_MINUTE?.trim();

	if (!rawValue) {
		return DEFAULT_SPOTIFY_REQUESTS_PER_MINUTE;
	}

	const parsedValue = Number.parseInt(rawValue, 10);

	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		throw new Error("SPOTIFY_REQUESTS_PER_MINUTE must be a positive integer when set.");
	}

	return parsedValue;
}

function getSpotifyMinimumIntervalMilliseconds(): number {
	return Math.ceil(60000 / getSpotifyRequestsPerMinute());
}

async function waitForSpotifyRequestSlot(): Promise<void> {
	const now = Date.now();
	const minimumIntervalMilliseconds = getSpotifyMinimumIntervalMilliseconds();
	const earliestNextRequestAt = lastSpotifyRequestStartedAt + minimumIntervalMilliseconds;
	const waitMilliseconds = Math.max(0, earliestNextRequestAt - now);

	if (waitMilliseconds > 0) {
		await sleep(waitMilliseconds);
	}

	lastSpotifyRequestStartedAt = Date.now();
}

async function spotifyFetch(input: string, init?: RequestInit): Promise<Response> {
	const queuedRequest = spotifyRequestQueue.then(async () => {
		await waitForSpotifyRequestSlot();
		return fetch(input, init);
	});

	spotifyRequestQueue = queuedRequest.then(
		() => undefined,
		() => undefined,
	);

	return queuedRequest;
}

async function readResponseBody(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

async function getSpotifyCurrentUser(accessToken: string): Promise<SpotifyCurrentUser | null> {
	const response = await spotifyFetch(`${SPOTIFY_API_BASE_URL}/me`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		return null;
	}

	return (await response.json()) as SpotifyCurrentUser;
}

async function getSpotifyPlaylistDetails(accessToken: string, playlistId: string): Promise<SpotifyPlaylistDetails | null> {
	const query = new URLSearchParams({
		fields: "id,name,public,collaborative,owner(id,display_name)",
	});
	const response = await spotifyFetch(`${SPOTIFY_API_BASE_URL}/playlists/${playlistId}?${query.toString()}`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		return null;
	}

	return (await response.json()) as SpotifyPlaylistDetails;
}

function formatSpotifyUser(user: SpotifyCurrentUser | null): string {
	if (!user) {
		return "unknown";
	}

	return user.display_name ? `${user.display_name} (${user.id})` : user.id;
}

function formatSpotifyPlaylistOwner(playlist: SpotifyPlaylistDetails | null): string {
	const ownerId = playlist?.owner?.id;
	const ownerName = playlist?.owner?.display_name;

	if (!ownerId) {
		return "unknown";
	}

	return ownerName ? `${ownerName} (${ownerId})` : ownerId;
}

async function buildSpotifyPlaylistPermissionError(
	accessToken: string,
	playlistId: string,
	operation: "clear" | "append" | "replace" | "delete",
	response: Response,
): Promise<Error> {
	const errorBody = await readResponseBody(response);

	if (response.status !== 403) {
		return new Error(
			`Failed to ${operation} Spotify playlist tracks: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
		);
	}

	const [currentUser, playlist] = await Promise.all([
		getSpotifyCurrentUser(accessToken),
		getSpotifyPlaylistDetails(accessToken, playlistId),
	]);

	const playlistVisibility = playlist?.collaborative
		? "collaborative"
		: playlist?.public
			? "public"
			: "private";

	return new Error(
		[
			`Spotify refused to ${operation} playlist ${playlistId}: 403 Forbidden${errorBody ? ` - ${errorBody}` : ""}.`,
			`Authenticated user: ${formatSpotifyUser(currentUser)}.`,
			`Playlist owner: ${formatSpotifyPlaylistOwner(playlist)}.`,
			`Playlist visibility: ${playlistVisibility}.`,
			"Use a refresh token for the playlist owner or for a user who can edit that playlist, and make sure the token was granted playlist-modify-private or playlist-modify-public.",
			"If you recently changed scopes, rerun bun run spotify:auth and replace SPOTIFY_REFRESH_TOKEN in .env.",
		].join(" "),
	);
}

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
	const chunks: T[][] = [];

	for (let index = 0; index < items.length; index += chunkSize) {
		chunks.push(items.slice(index, index + chunkSize));
	}

	return chunks;
}

async function getSpotifyPlaylistItemsPage(accessToken: string, playlistId: string, offset: number): Promise<SpotifyPlaylistItemPage> {
	const query = new URLSearchParams({
		limit: String(SPOTIFY_PLAYLIST_ITEMS_PAGE_SIZE),
		offset: String(offset),
		fields: "total,items(item(uri),episode(uri))",
		additional_types: "item,episode",
	});
	const response = await spotifyFetch(`${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/items?${query.toString()}`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		throw await buildSpotifyPlaylistPermissionError(accessToken, playlistId, "clear", response);
	}

	return (await response.json()) as SpotifyPlaylistItemPage;
}

function getSpotifyPlaylistItemUri(item: SpotifyPlaylistItemPage["items"][number]): string | null {
	return item.item?.uri ?? item.item?.uri ?? null;
}

async function clearSpotifyPlaylist(accessToken: string, playlistId: string): Promise<void> {
	while (true) {
		const page = await getSpotifyPlaylistItemsPage(accessToken, playlistId, 0);
		console.log(`Clearing Spotify playlist ${playlistId}:`, JSON.stringify(page));
		if (page.items.length === 0) {
			return;
		}

		const urisToDelete = page.items
			.map(getSpotifyPlaylistItemUri)
			.filter((uri): uri is string => Boolean(uri));

		if (urisToDelete.length === 0) {
			throw new Error("Spotify playlist contains items without removable URIs, so the playlist cannot be cleared automatically.");
		}

		for (const batch of chunkItems(urisToDelete, SPOTIFY_PLAYLIST_ITEMS_PAGE_SIZE)) {
			const deleteResponse = await spotifyFetch(`${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/items`, {
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					items: batch.map((uri) => ({ uri })),
				}),
			});

			if (!deleteResponse.ok) {
				throw await buildSpotifyPlaylistPermissionError(accessToken, playlistId, "delete", deleteResponse);
			}
		}
	}
}

function logSpotifyRateLimit(song: SongInfo, attempt: number, retryAfterHeader: string | null, delayMilliseconds: number): void {
	console.log(
		`Spotify rate limit for ${song.title} - ${song.artist}. attempt=${attempt + 1}/${SPOTIFY_MAX_RATE_LIMIT_RETRIES + 1}, retry-after=${retryAfterHeader ?? "missing"}, wait=${delayMilliseconds}ms`,
	);
}

function parseRetryAfterMilliseconds(retryAfterHeader: string): number | null {
	const numericValue = Number.parseInt(retryAfterHeader, 10);

	if (!Number.isFinite(numericValue) || numericValue < 0) {
		return null;
	}

	if (numericValue > 1000) {
		return numericValue;
	}

	return numericValue * 1000;
}

function getRetryDelayMilliseconds(response: Response, attempt: number): number {
	const retryAfterHeader = response.headers.get("retry-after");

	if (retryAfterHeader) {
		const retryAfterMilliseconds = parseRetryAfterMilliseconds(retryAfterHeader);
		if (retryAfterMilliseconds !== null) {
			return retryAfterMilliseconds;
		}
	}

	return Math.min(1000 * 2 ** attempt, 15000);
}

function normalizeSpotifySearchText(value: string): string {
	return value
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenizeSpotifySearchText(value: string): string[] {
	return normalizeSpotifySearchText(value)
		.split(" ")
		.filter(Boolean);
}

function countTokenOverlap(expectedTokens: string[], candidateTokens: string[]): number {
	if (expectedTokens.length === 0 || candidateTokens.length === 0) {
		return 0;
	}

	const candidateTokenSet = new Set(candidateTokens);
	return expectedTokens.filter((token) => candidateTokenSet.has(token)).length;
}

function hasSpotifyVersionMarker(value: string): boolean {
	return /\b(remix|mix|edit|version|refunk|vip|radio edit|extended|live|acoustic)\b/i.test(value);
}

function hasSpotifyUndesirableMarker(value: string): boolean {
	return /\b(karaoke|instrumental|tribute|cover|sped up|slowed|reverb)\b/i.test(value);
}

function stripSpotifyTitleMetadata(title: string): string {
	return title
		.replace(/\([^)]*\)/g, " ")
		.replace(/\[[^\]]*\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function simplifySpotifyTrackTitle(title: string): string {
	const withoutPrefix = title.includes(" - ") ? (title.split(" - ").at(-1) ?? title) : title;

	return withoutPrefix
		.replace(/\((?:[^)]*(?:remix|mix|edit|version|refunk)[^)]*)\)/gi, " ")
		.replace(/\[(?:[^\]]*(?:remix|mix|edit|version|refunk)[^\]]*)\]/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function splitSpotifyTitleParts(title: string): string[] {
	return title
		.split(/\s*(?:-|:|\||\/|\\)\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function splitSpotifyArtistTerms(artist: string): string[] {
	const parts = artist
		.split(/\s*(?:,|&|\bx\b|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bsu\b|\bir\b|\bvs\.?\b)\s*/gi)
		.map((part) => part.trim())
		.filter(Boolean);

	return parts.length > 0 ? parts : [artist.trim()];
}

function buildSpotifyTrackSearchQueries(song: SongInfo): string[] {
	const artistTerms = splitSpotifyArtistTerms(song.artist);
	const simplifiedTitle = simplifySpotifyTrackTitle(song.title);
	const rawTitle = song.title.trim();
	const primaryArtist = artistTerms[0] ?? song.artist.trim();

	return [...new Set([
		`${rawTitle} ${artistTerms.join(" ")}`.trim(),
		`${simplifiedTitle} ${artistTerms.join(" ")}`.trim(),
		`track:${simplifiedTitle} artist:${primaryArtist}`.trim(),
	])].filter(Boolean);
}

function evaluateSpotifyTrackTitle(songTitle: string, candidateTitle: string): SpotifyTitleMatch {
	const expectedTitle = normalizeSpotifySearchText(songTitle);
	const expectedSimplifiedTitle = normalizeSpotifySearchText(simplifySpotifyTrackTitle(songTitle));
	const expectedMetadataStrippedTitle = normalizeSpotifySearchText(stripSpotifyTitleMetadata(songTitle));
	const candidateNormalizedTitle = normalizeSpotifySearchText(candidateTitle);
	const candidateSimplifiedTitle = normalizeSpotifySearchText(simplifySpotifyTrackTitle(candidateTitle));
	const candidateMetadataStrippedTitle = normalizeSpotifySearchText(stripSpotifyTitleMetadata(candidateTitle));
	const expectedTitleParts = splitSpotifyTitleParts(songTitle)
		.map(normalizeSpotifySearchText)
		.filter(Boolean);
	const candidateTitleParts = splitSpotifyTitleParts(candidateTitle)
		.map(normalizeSpotifySearchText)
		.filter(Boolean);
	const expectedTitleTokens = tokenizeSpotifySearchText(stripSpotifyTitleMetadata(simplifySpotifyTrackTitle(songTitle)));
	const candidateTitleTokens = tokenizeSpotifySearchText(stripSpotifyTitleMetadata(simplifySpotifyTrackTitle(candidateTitle)));
	const titleTokenOverlap = countTokenOverlap(expectedTitleTokens, candidateTitleTokens);
	const matchRatio = expectedTitleTokens.length > 0 ? titleTokenOverlap / expectedTitleTokens.length : 0;

	if (expectedTitle && candidateNormalizedTitle === expectedTitle) {
		return { score: 120, hasMatch: true, matchRatio: 1, matchType: "exact" };
	}

	if (expectedSimplifiedTitle && candidateSimplifiedTitle === expectedSimplifiedTitle) {
		return { score: 105, hasMatch: true, matchRatio: 1, matchType: "simplified-exact" };
	}

	if (expectedMetadataStrippedTitle && candidateMetadataStrippedTitle === expectedMetadataStrippedTitle) {
		return { score: 95, hasMatch: true, matchRatio: 1, matchType: "metadata-stripped-exact" };
	}

	if (expectedTitleParts.length > 0 && candidateTitleParts.some((candidatePart) => expectedTitleParts.includes(candidatePart))) {
		return { score: 85, hasMatch: true, matchRatio: 1, matchType: "delimiter-part-exact" };
	}

	if (expectedTitleTokens.length > 0 && titleTokenOverlap === expectedTitleTokens.length) {
		return { score: 75, hasMatch: true, matchRatio, matchType: "full-token-overlap" };
	}

	if (expectedTitleTokens.length > 0 && matchRatio >= 0.7) {
		return { score: 50, hasMatch: true, matchRatio, matchType: "strong-token-overlap" };
	}

	if (
		expectedSimplifiedTitle
		&& (candidateSimplifiedTitle.startsWith(expectedSimplifiedTitle) || expectedSimplifiedTitle.startsWith(candidateSimplifiedTitle))
	) {
		return { score: 45, hasMatch: true, matchRatio, matchType: "prefix" };
	}

	if (
		expectedSimplifiedTitle
		&& (candidateSimplifiedTitle.includes(expectedSimplifiedTitle) || expectedSimplifiedTitle.includes(candidateSimplifiedTitle))
	) {
		return { score: 35, hasMatch: true, matchRatio, matchType: "substring" };
	}

	return { score: 0, hasMatch: false, matchRatio, matchType: "none" };
}

function evaluateSpotifyTrackCandidate(
	song: SongInfo,
	candidate: SpotifyTrackItem,
): { score: number; artistMatchCount: number; hasTitleMatch: boolean } {
	const expectedArtists = splitSpotifyArtistTerms(song.artist)
		.map(normalizeSpotifySearchText)
		.filter(Boolean);
	const candidateArtists = candidate.artists
		.map((artist) => normalizeSpotifySearchText(artist.name))
		.filter(Boolean);
	const titleMatch = evaluateSpotifyTrackTitle(song.title, candidate.name);

	let score = titleMatch.score;
	const hasTitleMatch = titleMatch.hasMatch;

	if (titleMatch.matchType === "exact" || titleMatch.matchType === "simplified-exact") {
		score += 10;
	}

	if (titleMatch.matchType === "full-token-overlap" && titleMatch.matchRatio === 1) {
		score += 10;
	}

	const artistMatchCount = expectedArtists.filter((expectedArtist) => {
		return candidateArtists.some((candidateArtist) => {
			return candidateArtist === expectedArtist || candidateArtist.includes(expectedArtist) || expectedArtist.includes(candidateArtist);
		});
	}).length;

	if (artistMatchCount > 0) {
		score += artistMatchCount * 25;
	}

	if (expectedArtists.length > 0 && artistMatchCount === expectedArtists.length) {
		score += 35;
	} else if (expectedArtists.length > 1 && artistMatchCount >= 2) {
		score += 20;
	}

	const primaryArtist = expectedArtists[0];
	if (primaryArtist && candidateArtists.some((candidateArtist) => candidateArtist === primaryArtist || candidateArtist.includes(primaryArtist) || primaryArtist.includes(candidateArtist))) {
		score += 40;
	}

	if (!hasSpotifyVersionMarker(song.title) && hasSpotifyVersionMarker(candidate.name)) {
		score -= 30;
	}

	if (hasSpotifyUndesirableMarker(candidate.name)) {
		score -= 80;
	}

	return { score, artistMatchCount, hasTitleMatch };
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

	const response = await spotifyFetch(SPOTIFY_ACCOUNTS_URL, {
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

async function searchSpotifyTracksRequest(accessToken: string, song: SongInfo, searchQuery: string): Promise<SpotifyTrackItem[]> {
	const query = new URLSearchParams({
		q: searchQuery,
		type: "track",
		limit: "5",
	});

	for (let attempt = 0; attempt <= SPOTIFY_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
		const response = await spotifyFetch(`${SPOTIFY_API_BASE_URL}/search?${query.toString()}`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		if (response.status === 429) {
			if (attempt === SPOTIFY_MAX_RATE_LIMIT_RETRIES) {
				throw new Error(`Spotify track search failed for ${song.title} - ${song.artist}: 429 Too Many Requests`);
			}

			const retryAfterHeader = response.headers.get("retry-after");
			const delayMilliseconds = getRetryDelayMilliseconds(response, attempt);
			logSpotifyRateLimit(song, attempt, retryAfterHeader, delayMilliseconds);
			await sleep(delayMilliseconds + 5000);
			continue;
		}

		if (!response.ok) {
			throw new Error(`Spotify track search failed for ${song.title} - ${song.artist}: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as {
			tracks?: {
				items?: SpotifyTrackItem[];
			};
		};

		return data.tracks?.items ?? [];
	}

	throw new Error(`Spotify track search failed for ${song.title} - ${song.artist}: retry limit exceeded`);
}

async function searchSpotifyTrack(accessToken: string, song: SongInfo): Promise<SpotifyTrackSearchResult | null> {
	let bestCandidate: { track: SpotifyTrackItem; score: number } | null = null;
	const expectedArtistCount = splitSpotifyArtistTerms(song.artist).length;
	const seenUris = new Set<string>();

	for (const searchQuery of buildSpotifyTrackSearchQueries(song)) {
		const tracks = await searchSpotifyTracksRequest(accessToken, song, searchQuery);

		for (const track of tracks) {
			if (seenUris.has(track.uri)) {
				continue;
			}

			seenUris.add(track.uri);

			const evaluation = evaluateSpotifyTrackCandidate(song, track);

			if (!evaluation.hasTitleMatch) {
				continue;
			}

			if (expectedArtistCount > 0 && evaluation.artistMatchCount === 0) {
				continue;
			}

			if (!bestCandidate || evaluation.score > bestCandidate.score) {
				bestCandidate = { track, score: evaluation.score };
			}
		}

		if (bestCandidate && bestCandidate.score >= 170) {
			break;
		}
	}

	if (!bestCandidate || bestCandidate.score < 120) {
		return null;
	}

	return {
		uri: bestCandidate.track.uri,
		name: bestCandidate.track.name,
		artistNames: bestCandidate.track.artists.map((artist) => artist.name),
	};
}

async function replaceSpotifyPlaylistTracks(accessToken: string, playlistId: string, uris: string[]): Promise<void> {
	await clearSpotifyPlaylist(accessToken, playlistId);

	for (const batch of chunkItems(uris, SPOTIFY_PLAYLIST_ITEMS_PAGE_SIZE)) {
		const appendResponse = await spotifyFetch(`${SPOTIFY_API_BASE_URL}/playlists/${playlistId}/items`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ uris: batch }),
		});

		if (!appendResponse.ok) {
			throw await buildSpotifyPlaylistPermissionError(accessToken, playlistId, "append", appendResponse);
		}
	}
}

export async function syncSpotifyPlaylist(songs: SongInfo[], playlistId: string): Promise<SpotifySyncSummary | null> {
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

	// const spotifyTrack = await searchSpotifyTrack(accessToken, {
    //   "radioStation": "M1",
    //   "title": "Higher",
    //   "artist": "NATHAN DAWE x JOEL CORY x SACHA",
    //   "playCount": 4,
    //   "spotifyUri": null,
    //   "pageDate": "balandžio 5d.",
    //   "time": "02:00"
    // });
	// console.log("Spotify search result for testing:", spotifyTrack);
	// return null;

	const skippedSongs: SpotifySyncSummary["skippedSongs"] = [];
	const matchedUris: string[] = [];

	for (const song of songs) {
		if (song.spotifyUri) {
			matchedUris.push(song.spotifyUri);
			continue;
		}

		const spotifyTrack = await searchSpotifyTrack(accessToken, song);

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

	await replaceSpotifyPlaylistTracks(accessToken, playlistId, matchedUris);

	return {
		playlistId,
		station: songs[0]?.radioStation ?? "unknown",
		requestedSongs: songs.length,
		matchedSongs: matchedUris.length,
		skippedSongs,
	};
}