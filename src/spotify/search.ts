import type { SongInfo } from "../types.ts";
import { SpotifyClient } from "./client.ts";
import type { SpotifyTitleMatch, SpotifyTrackItem, SpotifyTrackSearchResult } from "./types.ts";

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

export async function searchSpotifyTrack(
	client: SpotifyClient,
	accessToken: string,
	song: SongInfo,
): Promise<SpotifyTrackSearchResult | null> {
	let bestCandidate: { track: SpotifyTrackItem; score: number } | null = null;
	const expectedArtistCount = splitSpotifyArtistTerms(song.artist).length;
	const seenUris = new Set<string>();

	for (const searchQuery of buildSpotifyTrackSearchQueries(song)) {
		const tracks = await client.searchTracks(accessToken, searchQuery, {
			title: song.title,
			artist: song.artist,
		});

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