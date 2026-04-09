import type { SongInfo } from "../types.ts";

export type SpotifyTrackSearchResult = {
	uri: string;
	name: string;
	artistNames: string[];
};

export type SpotifyTrackItem = {
	uri: string;
	name: string;
	artists: Array<{ name: string }>;
};

export type SpotifyTitleMatch = {
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

export type SpotifyCurrentUser = {
	id: string;
	display_name?: string;
};

export type SpotifyPlaylistDetails = {
	id: string;
	name?: string;
	public?: boolean;
	collaborative?: boolean;
	owner?: {
		id?: string;
		display_name?: string;
	};
};

export type SpotifyPlaylistItemPage = {
	total: number;
	items: Array<{
		item?: { uri?: string | null } | null;
	}>;
};

export type SpotifySyncSummary = {
	playlistId: string;
	station: string;
	requestedSongs: number;
	matchedSongs: number;
	skippedSongs: SongInfo[];
};