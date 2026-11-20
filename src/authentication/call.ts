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

		this.app.post('/call/log', async (c) => {
			const authHeader = c.req.header("Authorization");
			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				return c.json({ success: false, error: "Unauthorized" }, 401);
			}

			try {
				const token = authHeader.replace("Bearer ", "");
				const payloadBase64 = token.split(".")[1];
				const payload = JSON.parse(atob(payloadBase64));
				const userId = payload.properties?.id || payload.sub;

				if (!userId) return c.json({ success: false, error: "Invalid token" }, 401);

				const { receiver_id, chat_id, type, status, duration } = await c.req.json();

				if (!receiver_id || !status) {
					return c.json({ success: false, error: "receiver_id and status are required" }, 400);
				}

				const callId = crypto.randomUUID();

				await this.env.DATA_DB.prepare(`
					INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status, duration)
					VALUES (?, ?, ?, ?, ?, ?, ?)
				`).bind(
					callId,
					userId,
					receiver_id,
					chat_id || null,
					type || 'audio',
					status,
					duration || 0
				).run();

				return c.json({ success: true, call_id: callId });
			} catch (error) {
				console.error("Call log error:", error);
				return c.json({ success: false, error: "Failed to save call log" }, 500);
			}
		});

		this.app.get('/call/history', async (c) => {
			const authHeader = c.req.header("Authorization");
			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				return c.json({ success: false, error: "Unauthorized" }, 401);
			}

			try {
				const token = authHeader.replace("Bearer ", "");
				const payloadBase64 = token.split(".")[1];
				const payload = JSON.parse(atob(payloadBase64));
				const userId = payload.properties?.id || payload.sub;

				if (!userId) return c.json({ success: false, error: "Invalid token" }, 401);

				const history = await this.env.DATA_DB.prepare(`
					SELECT 
						c.*,
						caller.username as caller_username,
						caller.yourname as caller_yourname,
						caller.avatar as caller_avatar,
						receiver.username as receiver_username,
						receiver.yourname as receiver_yourname,
						receiver.avatar as receiver_avatar
					FROM call_history c
					LEFT JOIN user caller ON c.caller_id = caller.id
					LEFT JOIN user receiver ON c.receiver_id = receiver.id
					WHERE c.caller_id = ? OR c.receiver_id = ?
					ORDER BY c.created_at DESC
					LIMIT 50
				`).bind(userId, userId).all();

				return c.json({ success: true, history: history.results });
			} catch (error) {
				console.error("Call history error:", error);
				return c.json({ success: false, error: "Failed to fetch call history" }, 500);
			}
		});
	}

	public getApp(): Hono {
		return this.app;
	}
}
