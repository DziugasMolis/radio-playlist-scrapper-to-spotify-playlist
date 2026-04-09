import type { SongInfo } from "../types.ts";
import { RadioStationScraper } from "./base.ts";

const RC_SEARCH_URL = "https://rc.lt/dainu-paieska";
const RC_API_BASE_URL = "https://rc.lt/api/songs";
const RC_DEFAULT_PAGE_SIZE = 10;
const RC_TIME_ZONE = "Europe/Vilnius";

type RcApiSong = {
	artist: string | null;
	song: string | null;
	played: string | null;
};

type RcSongsApiResponse = {
	data?: RcApiSong[];
};

type RcSession = {
	cookieHeader: string;
	xsrfToken: string;
};

type RcRequestTimestamp = {
	date: string;
	hour: string;
	minutes: string;
};

export class RCRadioStationScraper extends RadioStationScraper {
	public readonly radioStation = "RC";
	public readonly playlistId = Bun.env.SPOTIFY_PLAYLIST_ID_RC?.trim() ?? "";

	public buildPlaylistUrl(page: number): string {
		return `${RC_API_BASE_URL}?page=${page}`;
	}

	public async scrapeRadioStationPlaylist(page: number): Promise<SongInfo[]> {
		const session = await this.createSession();
		const url = this.buildPlaylistUrl(page);
		const requestTimestamp = this.getRequestTimestamp();
		const body = {
			station: "rc",
			limit: String(RC_DEFAULT_PAGE_SIZE),
			date: requestTimestamp.date,
			hour: requestTimestamp.hour,
			minutes: requestTimestamp.minutes,
		};

		const response = await fetch(url, {
			method: "POST",
			headers: {
				accept: "application/json, text/plain, */*",
				"content-type": "application/json;charset=UTF-8",
				origin: "https://rc.lt",
				referer: RC_SEARCH_URL,
				"user-agent": "Mozilla/5.0 (compatible; Bun scraper)",
				cookie: session.cookieHeader,
				"x-requested-with": "XMLHttpRequest",
				"x-xsrf-token": session.xsrfToken,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
		}

		const payload = (await response.json()) as RcSongsApiResponse;
		const songs = payload.data ?? [];

		return songs
			.map((song) => this.mapSong(song))
			.filter((song): song is SongInfo => song !== null);
	}

	private async createSession(): Promise<RcSession> {
		const response = await fetch(RC_SEARCH_URL, {
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; Bun scraper)",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch ${RC_SEARCH_URL}: ${response.status} ${response.statusText}`);
		}

		const cookieHeader = this.extractCookieHeader(response);
		const encodedXsrfToken = this.getCookieValue(cookieHeader, "XSRF-TOKEN");

		if (!encodedXsrfToken) {
			throw new Error("RC scraper could not find the XSRF token cookie.");
		}

		return {
			cookieHeader,
			xsrfToken: decodeURIComponent(encodedXsrfToken),
		};
	}

	private extractCookieHeader(response: Response): string {
		const setCookieHeader = response.headers.get("set-cookie");

		if (!setCookieHeader) {
			throw new Error("RC scraper did not receive session cookies.");
		}

		const cookiePairs = setCookieHeader
			.split(/,(?=[^;]+=)/)
			.map((cookie) => cookie.split(";")[0]?.trim())
			.filter((cookie): cookie is string => Boolean(cookie));

		return cookiePairs.join("; ");
	}

	private getCookieValue(cookieHeader: string, cookieName: string): string | null {
		for (const cookie of cookieHeader.split(";")) {
			const trimmedCookie = cookie.trim();
			if (!trimmedCookie.startsWith(`${cookieName}=`)) {
				continue;
			}

			return trimmedCookie.slice(cookieName.length + 1);
		}

		return null;
	}

	private mapSong(song: RcApiSong): SongInfo | null {
		const artist = this.cleanText(song.artist ?? "");
		const title = this.cleanText(song.song ?? "");
		const played = this.cleanText(song.played ?? "");

		if (!artist || !title || !played) {
			return null;
		}

		const [pageDate, time] = played.split(" ");

		if (!pageDate || !time) {
			return null;
		}

		return this.buildSongInfo({
			time,
			pageDate,
			title,
			artist,
		});
	}

	private getRequestTimestamp(): RcRequestTimestamp {
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: RC_TIME_ZONE,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
		const parts = formatter.formatToParts(new Date());
		const getPart = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";

		return {
			date: `${getPart("year")}-${getPart("month")}-${getPart("day")}`,
			hour: getPart("hour"),
			minutes: this.roundMinutesToFive(getPart("minute")),
		};
	}

	private roundMinutesToFive(minutes: string): string {
		const parsedMinutes = Number.parseInt(minutes, 10);

		if (!Number.isFinite(parsedMinutes)) {
			return "00";
		}

		const roundedMinutes = Math.min(55, Math.ceil(parsedMinutes / 5) * 5);
		return roundedMinutes.toString().padStart(2, "0");
	}
}