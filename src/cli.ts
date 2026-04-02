import type { CliOptions } from "./types.ts";

export function parseCliOptions(argv: string[]): CliOptions {
	let page = 1;
	let limit: number | null = null;
	let output = "songs.json";

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const nextValue = argv[index + 1];

		if (argument === "--page" && nextValue) {
			const parsedPage = Number.parseInt(nextValue, 10);
			if (Number.isInteger(parsedPage) && parsedPage > 0) {
				page = parsedPage;
			}
			index += 1;
			continue;
		}

		if (argument === "--limit" && nextValue) {
			const parsedLimit = Number.parseInt(nextValue, 10);
			if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
				limit = parsedLimit;
			}
			index += 1;
			continue;
		}

		if (argument === "--output" && nextValue) {
			output = nextValue;
			index += 1;
		}
	}

	return { page, limit, output };
}