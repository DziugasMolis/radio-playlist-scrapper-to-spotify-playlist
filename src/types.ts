export type RadioStationId = "m1" | "rc";

export type SongInfo = {
	radioStation: string;
	time: string;
	pageDate: string | null;
	title: string;
	artist: string;
	playCount: number;
	spotifyUri: string;
	spotifyTrackName: string;
	spotifyArtistName: string;
};

export type ScrapePayload = {
	source: string;
	count: number;
	songs: SongInfo[];
};

export type SpotifySkippedSongsPayload = {
	playlistId: string;
	station: string;
	requestedSongs: number;
	matchedSongs: number;
	skippedCount: number;
	songs: SongInfo[];
};