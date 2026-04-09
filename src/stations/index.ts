import type { RadioStationId } from "../types.ts";
import type { RadioStationScraper } from "./base.ts";
import { M1RadioStationScraper } from "./m1.ts";
import { RCRadioStationScraper } from "./rc.ts";

export function createRadioStationScraper(station: RadioStationId): RadioStationScraper {
	switch (station) {
		case "rc":
			return new RCRadioStationScraper();
		case "m1":
		default:
			return new M1RadioStationScraper();
	}
}