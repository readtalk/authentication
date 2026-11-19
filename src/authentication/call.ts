import { Hono } from "hono";
import { cors } from "hono/cors";

export class CallHandler {
	private app: Hono = new Hono();
	private env: any;

	constructor(env: any) {
		this.env = env;
		this.setupRoutes();
	}

	private setupRoutes() {
		this.app.use('*', cors({
			origin: '*',
			allowMethods: ['GET', 'POST', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'Authorization']
		}));

		this.app.post('/call/credentials', async (c) => {
			const authHeader = c.req.header("Authorization");
			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				return c.json({ success: false, error: "Unauthorized" }, 401);
			}

			try {
				const token = authHeader.replace("Bearer ", "");
				const payloadBase64 = token.split(".")[1];
				const payload = JSON.parse(atob(payloadBase64));
				const userId = payload.properties?.id || payload.sub;

				if (!userId) {
					return c.json({ success: false, error: "Invalid token" }, 401);
				}

				const response = await fetch(
					`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.REALTIME_CALL_KEY_ID}/credentials/generate-ice-servers`,
					{
						method: "POST",
						headers: {
							"Authorization": `Bearer ${this.env.REALTIME_CALL_SECRET}`,
							"Content-Type": "application/json"
						},
						body: JSON.stringify({ ttl: 86400 })
					}
				);

				if (!response.ok) {
					throw new Error(`Cloudflare RTC error: ${response.status}`);
				}

				const data = await response.json();
				return c.json({ success: true, iceServers: data.iceServers });
			} catch (error) {
				console.error("Call credentials error:", error);
				return c.json({ success: false, error: "Failed to generate call credentials" }, 500);
			}
		});
	}

	public getApp(): Hono {
		return this.app;
	}
}
