import { load } from "cheerio";
import type { SongInfo } from "../types.ts";

const RADIO_STATION = "M1";
const BASE_URL = "https://m-1.15min.lt";
const PLAYLIST_URL = `${BASE_URL}/grojarastis/`;

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function buildSongKey(title: string, artist: string): string {
	return `${title.toLocaleLowerCase()}::${artist.toLocaleLowerCase()}`;
}

export function buildM1PlaylistUrl(page: number): string {
	if (page <= 1) {
		return PLAYLIST_URL;
	}

	return `${PLAYLIST_URL}page/${page}/`;
}

export async function scrapeM1Playlist(page: number): Promise<SongInfo[]> {
	const url = buildM1PlaylistUrl(page);
	const response = await fetch(url, {
		headers: {
			"user-agent": "Mozilla/5.0 (compatible; Bun scraper)",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}

	const html = await response.text();
	const $ = load(html);
	const pageDate = cleanText($("header.style2 .col .time").first().text()) || null;

	const rawSongs = $(".item")
		.map((_, element) => {
			const item = $(element);
			const title = cleanText(item.find(".info .song").first().text());
			const artist = cleanText(item.find(".info .author").first().text());
			const time = cleanText(item.find(".length.mobile, .length").first().text());

			if (!title || !artist || !time) {
				return null;
			}

			return {
				radioStation: RADIO_STATION,
				time,
				pageDate,
				title,
				artist,
				playCount: 0,
			} satisfies SongInfo;
		})
		.get()
		.filter((song): song is SongInfo => song !== null);

	const playCounts = new Map<string, number>();

	for (const song of rawSongs) {
		const songKey = buildSongKey(song.title, song.artist);
		playCounts.set(songKey, (playCounts.get(songKey) ?? 0) + 1);
	}

	const seenSongs = new Set<string>();

	return rawSongs
		.map((song) => {
			const songKey = buildSongKey(song.title, song.artist);

			return {
				...song,
				playCount: playCounts.get(songKey) ?? 1,
			};
		})
		.filter((song) => {
			const songKey = buildSongKey(song.title, song.artist);

			if (seenSongs.has(songKey)) {
				return false;
			}

			seenSongs.add(songKey);
			return true;
		})
		.sort((left, right) => {
			if (right.playCount !== left.playCount) {
				return right.playCount - left.playCount;
			}

			return right.time.localeCompare(left.time);
		});
}