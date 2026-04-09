import type { SongInfo } from "../types.ts";

type BuildSongInfoInput = {
	time: string;
	pageDate: string | null;
	title: string;
	artist: string;
};

export abstract class RadioStationScraper {
	public abstract readonly radioStation: string;
	public abstract readonly playlistId: string;

	public abstract buildPlaylistUrl(page: number): string;

	public abstract scrapeRadioStationPlaylist(page: number): Promise<SongInfo[]>;

	protected cleanText(value: string): string {
		return value.replace(/\s+/g, " ").trim();
	}

	protected async fetchPlaylistPage(url: string): Promise<string> {
		const response = await fetch(url, {
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; Bun scraper)",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
		}

		return response.text();
	}

	protected buildSongInfo(input: BuildSongInfoInput): SongInfo {
		return {
			radioStation: this.radioStation,
			time: input.time,
			pageDate: input.pageDate,
			title: input.title,
			artist: input.artist,
			playCount: 1,
			spotifyArtistName: "",
			spotifyTrackName: "",
			spotifyUri: "",
		};
	}
}