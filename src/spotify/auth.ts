const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SCOPES = [
	"playlist-read-private",
	"playlist-read-collaborative",
	"playlist-modify-private",
	"playlist-modify-public",
	"user-read-private",
];

type SpotifyAuthConfig = {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
};

type SpotifyTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
	scope?: string;
	error?: string;
	error_description?: string;
};

function getSpotifyAuthConfig(): SpotifyAuthConfig {
	const clientId = Bun.env.SPOTIFY_CLIENT_ID?.trim();
	const clientSecret = Bun.env.SPOTIFY_CLIENT_SECRET?.trim();
	const redirectUri = Bun.env.SPOTIFY_REDIRECT_URI?.trim();

	if (!clientId || !clientSecret || !redirectUri) {
		throw new Error("Missing Spotify auth configuration. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI.");
	}

	return {
		clientId,
		clientSecret,
		redirectUri,
	};
}

function buildAuthorizeUrl(config: SpotifyAuthConfig, state: string): string {
	const query = new URLSearchParams({
		client_id: config.clientId,
		response_type: "code",
		redirect_uri: config.redirectUri,
		scope: SPOTIFY_SCOPES.join(" "),
		state,
		show_dialog: "true",
	});

	return `${SPOTIFY_AUTHORIZE_URL}?${query.toString()}`;
}

async function exchangeCodeForTokens(config: SpotifyAuthConfig, code: string): Promise<SpotifyTokenResponse> {
	const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: config.redirectUri,
	});

	const response = await fetch(SPOTIFY_TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${basicAuth}`,
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});

	const data = (await response.json()) as SpotifyTokenResponse;

	if (!response.ok) {
		throw new Error(data.error_description ?? `Failed to exchange authorization code: ${response.status} ${response.statusText}`);
	}

	return data;
}

function openBrowser(url: string): void {
	const platform = process.platform;

	if (platform === "win32") {
		Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", url], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return;
	}

	if (platform === "darwin") {
		Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
		return;
	}

	Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
}

export async function runSpotifyAuthFlow(): Promise<void> {
	const config = getSpotifyAuthConfig();
	const redirectUrl = new URL(config.redirectUri);
	const expectedPath = redirectUrl.pathname || "/";
	const state = crypto.randomUUID();
	const authorizeUrl = buildAuthorizeUrl(config, state);

	console.log("Starting Spotify authorization flow...");
	console.log(`Using redirect URI: ${config.redirectUri}`);
	console.log("If the browser does not open automatically, open this URL manually:");
	console.log(authorizeUrl);

	const authResult = await new Promise<SpotifyTokenResponse>((resolve, reject) => {
		const timeout = setTimeout(() => {
			server.stop(true);
			reject(new Error("Timed out waiting for Spotify authorization callback."));
		}, 120000);

		const server = Bun.serve({
			hostname: redirectUrl.hostname,
			port: Number.parseInt(redirectUrl.port || "80", 10),
			fetch(request) {
				const requestUrl = new URL(request.url);

				if (requestUrl.pathname !== expectedPath) {
					return new Response("Not found", { status: 404 });
				}

				const code = requestUrl.searchParams.get("code");
				const returnedState = requestUrl.searchParams.get("state");
				const error = requestUrl.searchParams.get("error");

				if (error) {
					clearTimeout(timeout);
					server.stop(true);
					reject(new Error(`Spotify authorization failed: ${error}`));
					return new Response("Spotify authorization failed. You can close this window.", { status: 400 });
				}

				if (!code || returnedState !== state) {
					clearTimeout(timeout);
					server.stop(true);
					reject(new Error("Invalid Spotify authorization callback."));
					return new Response("Invalid authorization callback. You can close this window.", { status: 400 });
				}

				queueMicrotask(async () => {
					try {
						const tokenResponse = await exchangeCodeForTokens(config, code);
						clearTimeout(timeout);
						server.stop(true);
						resolve(tokenResponse);
					} catch (errorValue) {
						clearTimeout(timeout);
						server.stop(true);
						reject(errorValue);
					}
				});

				return new Response("Spotify authorization completed. You can close this window.", {
					headers: {
						"content-type": "text/plain; charset=utf-8",
					},
				});
			},
		});

		openBrowser(authorizeUrl);
	});

	console.log("Spotify authorization succeeded.");
	console.log("Add these values to your .env file:");
	console.log(`SPOTIFY_ACCESS_TOKEN=${authResult.access_token ?? ""}`);
	console.log(`SPOTIFY_REFRESH_TOKEN=${authResult.refresh_token ?? ""}`);
	console.log(`SPOTIFY_REDIRECT_URI=${config.redirectUri}`);
	console.log(`SPOTIFY_TOKEN_TYPE=${authResult.token_type ?? "Bearer"}`);
	console.log(`SPOTIFY_EXPIRES_IN=${authResult.expires_in ?? 0}`);
	console.log(`SPOTIFY_SCOPE=${authResult.scope ?? SPOTIFY_SCOPES.join(" ")}`);
}