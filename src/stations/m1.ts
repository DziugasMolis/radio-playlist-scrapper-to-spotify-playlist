import { load } from "cheerio";
import type { SongInfo } from "../types.ts";
import { RadioStationScraper } from "./base.ts";

const BASE_URL = "https://m-1.15min.lt";
const PLAYLIST_URL = `${BASE_URL}/grojarastis/`;


export class M1RadioStationScraper extends RadioStationScraper {
	radioStation = "M1";
	playlistId = Bun.env.SPOTIFY_PLAYLIST_ID_M1?.trim() ?? "";

	public buildPlaylistUrl(page: number): string {
		if (page <= 1) {
			return PLAYLIST_URL;
		}

		return `${PLAYLIST_URL}page/${page}/`;
	}

	public async scrapeRadioStationPlaylist(page: number): Promise<SongInfo[]> {
		const url = this.buildPlaylistUrl(page);
		const html = await this.fetchPlaylistPage(url);
		const $ = load(html);
		const pageDate = this.cleanText($("header.style2 .col .time").first().text()) || null;

		const rawSongs = $(".item")
			.map((_, element) => {
				const item = $(element);
				const title = this.cleanText(item.find(".info .song").first().text());
				const artist = this.cleanText(item.find(".info .author").first().text());
				const time = this.cleanText(item.find(".length.mobile, .length").first().text());

				if (!title || !artist || !time) {
					return null;
				}

				return this.buildSongInfo({
					time,
					pageDate,
					title,
					artist,
				});
			})
			.get()
			.filter((song): song is SongInfo => song !== null);

		return rawSongs;
	}
}

export function buildM1PlaylistUrl(page: number): string {
	return new M1RadioStationScraper().buildPlaylistUrl(page);
}

export async function scrapeM1Playlist(page: number): Promise<SongInfo[]> {
	return new M1RadioStationScraper().scrapeRadioStationPlaylist(page);
}