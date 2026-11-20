import { Hono } from "hono";
import { cors } from "hono/cors";

export class CallHandler {
  private app: Hono = new Hono();
  private env: any;

  constructor(env: any) {
    this.env = env;
    this.setupRoutes();
  }

  private async ensureTable() {
    await this.env.DATA_DB.prepare(
      `CREATE TABLE IF NOT EXISTS call_history ( id TEXT PRIMARY KEY, caller_id TEXT NOT NULL, receiver_id TEXT NOT NULL, chat_id TEXT, type TEXT DEFAULT 'audio', status TEXT NOT NULL, duration INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`
    ).run();
  }

  private setupRoutes() {
    this.app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'] }));

    this.app.post('/calls', async (c) => {
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
        const body = await c.req.json().catch(() => ({}));
        const { receiver_id, chat_id, type } = body;
        if (!receiver_id) {
          return c.json({ success: false, error: "receiver_id is required" }, 400);
        }
        const callId = crypto.randomUUID();
        return c.json({ success: true, call_id: callId, caller_id: userId, receiver_id, chat_id: chat_id || null, type: type || 'audio' });
      } catch (error) {
        console.error("Create call error:", error);
        return c.json({ success: false, error: "Failed to create call" }, 500);
      }
    });

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
        const keyId = this.env.CALL_TURN_KEY_ID;
        const apiToken = this.env.CALL_APP_SECRET;
        if (!keyId || !apiToken) {
          return c.json({ success: false, error: "Call service not configured" }, 500);
        }
        const response = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ttl: 86400 })
          }
        );
        if (!response.ok) {
          const errText = await response.text();
          console.error("Cloudflare RTC error:", response.status, errText);
          throw new Error(`Cloudflare RTC error: ${response.status}`);
        }
        const data: any = await response.json();
        const iceServers = data.result?.iceServers || data.iceServers || [];
        return c.json({ success: true, iceServers });
      } catch (error) {
        console.error("Call credentials error:", error);
        return c.json({ success: false, error: "Failed to generate call credentials" }, 500);
      }
    });

    this.app.post('/call/session', async (c) => {
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
        const appId = this.env.CALL_APP_ID;
        const appSecret = this.env.CALL_APP_SECRET;
        if (!appId || !appSecret) {
          return c.json({ success: false, error: "Call service not configured" }, 500);
        }
        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/new`,
          {
            method: "POST",
            headers: { "Authorization": `Bearer ${appSecret}`, "Content-Type": "application/json" },
            body: JSON.stringify({})
          }
        );
        if (!res.ok) {
          const errText = await res.text();
          console.error("Cloudflare Session error:", res.status, errText);
          throw new Error(`Session error: ${res.status}`);
        }
        const data: any = await res.json();
        const sessionId = data.result?.sessionId || data.sessionId;
        const session = data.result || data;
        return c.json({ success: true, sessionId, session });
      } catch (e) {
        console.error(e);
        return c.json({ success: false, error: "Failed to create session" }, 500);
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
        if (!userId) {
          return c.json({ success: false, error: "Invalid token" }, 401);
        }
        await this.ensureTable();
        const { receiver_id, chat_id, type, status, duration } = await c.req.json();
        if (!receiver_id || !status) {
          return c.json({ success: false, error: "receiver_id and status are required" }, 400);
        }
        const callId = crypto.randomUUID();
        await this.env.DATA_DB.prepare(
          `INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status, duration) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(callId, userId, receiver_id, chat_id || null, type || 'audio', status, duration || 0).run();
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
        if (!userId) {
          return c.json({ success: false, error: "Invalid token" }, 401);
        }
        await this.ensureTable();
        const history = await this.env.DATA_DB.prepare(
          `SELECT c.*, caller.username as caller_username, caller.yourname as caller_yourname, caller.avatar as caller_avatar, receiver.username as receiver_username, receiver.yourname as receiver_yourname, receiver.avatar as receiver_avatar FROM call_history c LEFT JOIN user caller ON c.caller_id = caller.id LEFT JOIN user receiver ON c.receiver_id = receiver.id WHERE c.caller_id = ? OR c.receiver_id = ? ORDER BY c.created_at DESC LIMIT 50`
        ).bind(userId, userId).all();
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
