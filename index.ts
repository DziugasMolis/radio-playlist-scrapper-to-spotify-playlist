import { runApp } from "./src/app.ts";
import type { RadioStationId } from "./src/types.ts";

const stationArgument = Bun.argv[2];

if (stationArgument && stationArgument !== "m1" && stationArgument !== "rc") {
	throw new Error(`Unknown station '${stationArgument}'. Use 'm1' or 'rc'.`);
}

const stations = stationArgument ? [stationArgument as RadioStationId] : undefined;

await runApp(stations);