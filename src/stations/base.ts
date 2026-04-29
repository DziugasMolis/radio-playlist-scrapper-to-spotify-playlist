import type { SongInfo } from "../types.ts";

type BuildSongInfoInput = {
	time: string;
	pageDate: string | null;
	title: string;
	artist: string;
};

type PlayedTimeRange = {
	start: string;
	end: string;
};

export abstract class RadioStationScraper {
	public abstract readonly radioStation: string;
	public abstract readonly playlistId: string;
	protected readonly allowedPlayedTimeRange: PlayedTimeRange | null = null;

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

	protected buildSongInfo(input: BuildSongInfoInput): SongInfo | null {
		if (!this.isAllowedPlayedTime(input.time)) {
			return null;
		}

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

	private isAllowedPlayedTime(value: string): boolean {
		const playedTime = this.parseTimeToSeconds(value);

		if (playedTime === null) {
			return false;
		}

		if (!this.allowedPlayedTimeRange) {
			return true;
		}

		const rangeStart = this.parseTimeToSeconds(this.allowedPlayedTimeRange.start);
		const rangeEnd = this.parseTimeToSeconds(this.allowedPlayedTimeRange.end);

		if (rangeStart === null || rangeEnd === null) {
			return false;
		}

		return playedTime >= rangeStart && playedTime <= rangeEnd;
	}

	private parseTimeToSeconds(value: string): number | null {
		const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

		if (!match) {
			return null;
		}

		const [, hoursText, minutesText, secondsText] = match;

		if (!hoursText || !minutesText) {
			return null;
		}

		const hours = Number.parseInt(hoursText, 10);
		const minutes = Number.parseInt(minutesText, 10);
		const seconds = secondsText ? Number.parseInt(secondsText, 10) : 0;

		if (
			!Number.isInteger(hours)
			|| !Number.isInteger(minutes)
			|| !Number.isInteger(seconds)
			|| hours < 0
			|| hours > 23
			|| minutes < 0
			|| minutes > 59
			|| seconds < 0
			|| seconds > 59
		) {
			return null;
		}

		return (hours * 60 * 60) + (minutes * 60) + seconds;
	}
}