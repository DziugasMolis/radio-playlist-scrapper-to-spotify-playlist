import type {
	SpotifyCurrentUser,
	SpotifyPlaylistDetails,
	SpotifyPlaylistItemPage,
	SpotifyTrackItem,
} from "./types.ts";

const SPOTIFY_ACCOUNTS_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";
const SPOTIFY_MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_SPOTIFY_REQUESTS_PER_MINUTE = 60;
const SPOTIFY_PLAYLIST_ITEMS_PAGE_SIZE = 100;

export type SpotifyClientConfig = {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	requestsPerMinute?: number;
};

type SpotifyRequestContext = {
	title: string;
	artist: string;
};

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseSpotifyRequestsPerMinute(rawValue: string | undefined): number {
	if (!rawValue?.trim()) {
		return DEFAULT_SPOTIFY_REQUESTS_PER_MINUTE;
	}

	const parsedValue = Number.parseInt(rawValue.trim(), 10);

	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		throw new Error("SPOTIFY_REQUESTS_PER_MINUTE must be a positive integer when set.");
	}

	return parsedValue;
}

export function getSpotifyClientFromEnv(): SpotifyClient | null {
	const clientId = Bun.env.SPOTIFY_CLIENT_ID?.trim();
	const clientSecret = Bun.env.SPOTIFY_CLIENT_SECRET?.trim();
	const refreshToken = Bun.env.SPOTIFY_REFRESH_TOKEN?.trim();

	if (!clientId || !clientSecret || !refreshToken) {
		return null;
	}

	return new SpotifyClient({
		clientId,
		clientSecret,
		refreshToken,
		requestsPerMinute: parseSpotifyRequestsPerMinute(Bun.env.SPOTIFY_REQUESTS_PER_MINUTE),
	});
}

export class SpotifyClient {
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly refreshToken: string;
	private readonly requestsPerMinute: number;
	private requestQueue = Promise.resolve();
	private lastRequestStartedAt = 0;

	constructor(config: SpotifyClientConfig) {
		this.clientId = config.clientId;
		this.clientSecret = config.clientSecret;
		this.refreshToken = config.refreshToken;
		this.requestsPerMinute = config.requestsPerMinute ?? DEFAULT_SPOTIFY_REQUESTS_PER_MINUTE;
	}

	async getAccessToken(): Promise<string | null> {
		const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: this.refreshToken,
		});

		const response = await this.queueRequest(SPOTIFY_ACCOUNTS_URL, {
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

	async searchTracks(
		accessToken: string,
		searchQuery: string,
		context: SpotifyRequestContext,
		limit = 5,
	): Promise<SpotifyTrackItem[]> {
		const query = new URLSearchParams({
			q: searchQuery,
			type: "track",
			limit: String(limit),
		});

		for (let attempt = 0; attempt <= SPOTIFY_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
			const response = await this.fetchApi(`/search?${query.toString()}`, accessToken);

			if (response.status === 429) {
				if (attempt === SPOTIFY_MAX_RATE_LIMIT_RETRIES) {
					throw new Error(`Spotify track search failed for ${context.title} - ${context.artist}: 429 Too Many Requests`);
				}

				const retryAfterHeader = response.headers.get("retry-after");
				const delayMilliseconds = this.getRetryDelayMilliseconds(response, attempt);
				this.logSpotifyRateLimit(context, attempt, retryAfterHeader, delayMilliseconds);
				await sleep(delayMilliseconds + 5000);
				continue;
			}

			if (!response.ok) {
				throw new Error(`Spotify track search failed for ${context.title} - ${context.artist}: ${response.status} ${response.statusText}`);
			}

			const data = (await response.json()) as {
				tracks?: {
					items?: SpotifyTrackItem[];
				};
			};

			return data.tracks?.items ?? [];
		}

		throw new Error(`Spotify track search failed for ${context.title} - ${context.artist}: retry limit exceeded`);
	}

	async replacePlaylistTracks(accessToken: string, playlistId: string, uris: string[]): Promise<void> {
		await this.clearPlaylist(accessToken, playlistId);

		for (const batch of this.chunkItems(uris, SPOTIFY_PLAYLIST_ITEMS_PAGE_SIZE)) {
			const appendResponse = await this.fetchApi(`/playlists/${playlistId}/items`, accessToken, {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({ uris: batch }),
			});

			if (!appendResponse.ok) {
				throw await this.buildPlaylistPermissionError(accessToken, playlistId, "append", appendResponse);
			}
		}
	}

	private getMinimumIntervalMilliseconds(): number {
		return Math.ceil(60000 / this.requestsPerMinute);
	}

	private async waitForRequestSlot(): Promise<void> {
		const now = Date.now();
		const minimumIntervalMilliseconds = this.getMinimumIntervalMilliseconds();
		const earliestNextRequestAt = this.lastRequestStartedAt + minimumIntervalMilliseconds;
		const waitMilliseconds = Math.max(0, earliestNextRequestAt - now);

		if (waitMilliseconds > 0) {
			await sleep(waitMilliseconds);
		}

		this.lastRequestStartedAt = Date.now();
	}

	private async queueRequest(input: string, init?: RequestInit): Promise<Response> {
		const queuedRequest = this.requestQueue.then(async () => {
			await this.waitForRequestSlot();
			return fetch(input, init);
		});

		this.requestQueue = queuedRequest.then(
			() => undefined,
			() => undefined,
		);

		return queuedRequest;
	}

	private async fetchApi(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${accessToken}`);

		return this.queueRequest(`${SPOTIFY_API_BASE_URL}${path}`, {
			...init,
			headers,
		});
	}

	private async readResponseBody(response: Response): Promise<string> {
		try {
			return await response.text();
		} catch {
			return "";
		}
	}

	private async getCurrentUser(accessToken: string): Promise<SpotifyCurrentUser | null> {
		const response = await this.fetchApi("/me", accessToken);

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as SpotifyCurrentUser;
	}

	private async getPlaylistDetails(accessToken: string, playlistId: string): Promise<SpotifyPlaylistDetails | null> {
		const query = new URLSearchParams({
			fields: "id,name,public,collaborative,owner(id,display_name)",
		});
		const response = await this.fetchApi(`/playlists/${playlistId}?${query.toString()}`, accessToken);

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as SpotifyPlaylistDetails;
	}

	private formatSpotifyUser(user: SpotifyCurrentUser | null): string {
		if (!user) {
			return "unknown";
		}

		return user.display_name ? `${user.display_name} (${user.id})` : user.id;
	}

	private formatSpotifyPlaylistOwner(playlist: SpotifyPlaylistDetails | null): string {
		const ownerId = playlist?.owner?.id;
		const ownerName = playlist?.owner?.display_name;

		if (!ownerId) {
			return "unknown";
		}

		return ownerName ? `${ownerName} (${ownerId})` : ownerId;
	}

	private async buildPlaylistPermissionError(
		accessToken: string,
		playlistId: string,
		operation: "clear" | "append" | "replace" | "delete",
		response: Response,
	): Promise<Error> {
		const errorBody = await this.readResponseBody(response);

		if (response.status !== 403) {
			return new Error(
				`Failed to ${operation} Spotify playlist tracks: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
			);
		}

		const [currentUser, playlist] = await Promise.all([
			this.getCurrentUser(accessToken),
			this.getPlaylistDetails(accessToken, playlistId),
		]);

		const playlistVisibility = playlist?.collaborative
			? "collaborative"
			: playlist?.public
				? "public"
				: "private";

		return new Error(
			[
				`Spotify refused to ${operation} playlist ${playlistId}: 403 Forbidden${errorBody ? ` - ${errorBody}` : ""}.`,
				`Authenticated user: ${this.formatSpotifyUser(currentUser)}.`,
				`Playlist owner: ${this.formatSpotifyPlaylistOwner(playlist)}.`,
				`Playlist visibility: ${playlistVisibility}.`,
				"Use a refresh token for the playlist owner or for a user who can edit that playlist, and make sure the token was granted playlist-modify-private or playlist-modify-public.",
				"If you recently changed scopes, rerun bun run spotify:auth and replace SPOTIFY_REFRESH_TOKEN in .env.",
			].join(" "),
		);
	}

	private chunkItems<T>(items: T[], chunkSize: number): T[][] {
		const chunks: T[][] = [];

		for (let index = 0; index < items.length; index += chunkSize) {
			chunks.push(items.slice(index, index + chunkSize));
		}

		return chunks;
	}

	private async getPlaylistItemsPage(accessToken: string, playlistId: string, offset: number): Promise<SpotifyPlaylistItemPage> {
		const query = new URLSearchParams({
			limit: String(SPOTIFY_PLAYLIST_ITEMS_PAGE_SIZE),
			offset: String(offset),
			fields: "total,items(item(uri),episode(uri))",
			additional_types: "item,episode",
		});
		const response = await this.fetchApi(`/playlists/${playlistId}/items?${query.toString()}`, accessToken);

		if (!response.ok) {
			throw await this.buildPlaylistPermissionError(accessToken, playlistId, "clear", response);
		}

		return (await response.json()) as SpotifyPlaylistItemPage;
	}

	private getPlaylistItemUri(item: SpotifyPlaylistItemPage["items"][number]): string | null {
		return item.item?.uri ?? item.item?.uri ?? null;
	}

	private async clearPlaylist(accessToken: string, playlistId: string): Promise<void> {
		while (true) {
			const page = await this.getPlaylistItemsPage(accessToken, playlistId, 0);
			console.log(`Clearing Spotify playlist ${playlistId}:`, JSON.stringify(page));

			if (page.items.length === 0) {
				return;
			}

			const urisToDelete = page.items
				.map((item) => this.getPlaylistItemUri(item))
				.filter((uri): uri is string => Boolean(uri));

			if (urisToDelete.length === 0) {
				throw new Error("Spotify playlist contains items without removable URIs, so the playlist cannot be cleared automatically.");
			}

			for (const batch of this.chunkItems(urisToDelete, SPOTIFY_PLAYLIST_ITEMS_PAGE_SIZE)) {
				const deleteResponse = await this.fetchApi(`/playlists/${playlistId}/items`, accessToken, {
					method: "DELETE",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify({
						items: batch.map((uri) => ({ uri })),
					}),
				});

				if (!deleteResponse.ok) {
					throw await this.buildPlaylistPermissionError(accessToken, playlistId, "delete", deleteResponse);
				}
			}
		}
	}

	private logSpotifyRateLimit(context: SpotifyRequestContext, attempt: number, retryAfterHeader: string | null, delayMilliseconds: number): void {
		console.log(
			`Spotify rate limit for ${context.title} - ${context.artist}. attempt=${attempt + 1}/${SPOTIFY_MAX_RATE_LIMIT_RETRIES + 1}, retry-after=${retryAfterHeader ?? "missing"}, wait=${delayMilliseconds}ms`,
		);
	}

	private parseRetryAfterMilliseconds(retryAfterHeader: string): number | null {
		const numericValue = Number.parseInt(retryAfterHeader, 10);

		if (!Number.isFinite(numericValue) || numericValue < 0) {
			return null;
		}

		if (numericValue > 1000) {
			return numericValue;
		}

		return numericValue * 1000;
	}

	private getRetryDelayMilliseconds(response: Response, attempt: number): number {
		const retryAfterHeader = response.headers.get("retry-after");

		if (retryAfterHeader) {
			const retryAfterMilliseconds = this.parseRetryAfterMilliseconds(retryAfterHeader);
			if (retryAfterMilliseconds !== null) {
				return retryAfterMilliseconds;
			}
		}

		return Math.min(1000 * 2 ** attempt, 15000);
	}
}