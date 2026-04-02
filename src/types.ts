export type SongInfo = {
	radioStation: string;
	time: string;
	pageDate: string | null;
	title: string;
	artist: string;
	playCount: number;
};

export type CliOptions = {
	page: number;
	limit: number | null;
	output: string;
};

export type ScrapePayload = {
	source: string;
	count: number;
	songs: SongInfo[];
};