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
      `CREATE TABLE IF NOT EXISTS call_history (
        id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        chat_id TEXT,
        type TEXT DEFAULT 'audio',
        status TEXT NOT NULL,
        duration INTEGER DEFAULT 0,
        created_at INTEGER
      )`
    ).run();
  }

  private getUserId(c: any) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader) return "";
    const token = authHeader.replace("Bearer ", "");
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      return payload.properties?.id || payload.sub || "";
    } catch {
      return "";
    }
  }

  private setupRoutes() {
    this.app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"] }));

    // --- TURN / ICE, dari File 2 cURL ---
    this.app.post("/call/credentials", async (c) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      try {
        const token = authHeader.replace("Bearer ", "");
        const payload = JSON.parse(atob(token.split(".")[1]));
        const userId = payload.properties?.id || payload.sub;
        if (!userId) return c.json({ success: false, error: "Invalid token" }, 401);

        const keyId = this.env.CALL_TURN_KEY_ID;
        const apiToken = this.env.CALL_APP_SECRET;
        if (!keyId || !apiToken) {
          return c.json({ success: false, error: "Call service not configured" }, 500);
        }

        const response = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ttl: 86400 }),
          }
        );
        if (!response.ok) throw new Error(`Cloudflare RTC error: ${response.status}`);
        const data: any = await response.json();
        const iceServers = data.result?.iceServers || data.iceServers || [];
        return c.json({ success: true, iceServers });
      } catch (e) {
        console.error("Call credentials error:", e);
        return c.json({ success: false, error: "Failed to generate call credentials" }, 500);
      }
    });

    // --- SESSION, dari File 1 Echo Demo, tapi SDP diterusin ---
    this.app.post("/call/session", async (c) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      try {
        const token = authHeader.replace("Bearer ", "");
        const payload = JSON.parse(atob(token.split(".")[1]));
        const userId = payload.properties?.id || payload.sub;
        if (!userId) return c.json({ success: false, error: "Invalid token" }, 401);

        const appId = this.env.CALL_APP_ID;
        const appSecret = this.env.CALL_APP_SECRET;
        if (!appId || !appSecret) {
          return c.json({ success: false, error: "Call service not configured" }, 500);
        }

        const body: any = await c.req.json().catch(() => ({}));
        // Frontend kirim: { sdp: offerSDP } atau { sessionDescription: { type, sdp } }
        const sdp = body.sdp || body.sessionDescription?.sdp || body.offer || "";
        const sessionBody: any = sdp
          ? { sessionDescription: { type: "offer", sdp } }
          : {};

        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/new`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" },
            body: JSON.stringify(sessionBody),
          }
        );
        if (!res.ok) throw new Error(`Session error: ${res.status}`);
        const data: any = await res.json();
        const sessionId = data.result?.sessionId || data.sessionId;
        const session = data.result || data;
        return c.json({ success: true, sessionId, session });
      } catch (e) {
        console.error(e);
        return c.json({ success: false, error: "Failed to create session" }, 500);
      }
    });

    // --- TRACKS: publish local + subscribe remote ---
    // Echo Demo: newTracks(trackObjects, offerSDP)
    // Call 2 orang: callee subscribe pake { location: 'remote', sessionId: callerSessionId, trackName }
    this.app.post("/call/tracks", async (c) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      try {
        const token = authHeader.replace("Bearer ", "");
        const payload = JSON.parse(atob(token.split(".")[1]));
        const userId = payload.properties?.id || payload.sub;
        if (!userId) return c.json({ success: false, error: "Invalid token" }, 401);

        const appId = this.env.CALL_APP_ID;
        const appSecret = this.env.CALL_APP_SECRET;
        if (!appId || !appSecret) {
          return c.json({ success: false, error: "Call service not configured" }, 500);
        }

        const body: any = await c.req.json().catch(() => ({}));
        const sessionId = body.sessionId;
        const tracks = body.tracks || [];
        const sdp = body.sdp || body.sessionDescription?.sdp || null;
        if (!sessionId || !tracks.length) {
          return c.json({ success: false, error: "sessionId and tracks required" }, 400);
        }

        const cfBody: any = { tracks };
        if (sdp) cfBody.sessionDescription = { type: "offer", sdp };

        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/${sessionId}/tracks/new`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" },
            body: JSON.stringify(cfBody),
          }
        );
        if (!res.ok) throw new Error(`Tracks error: ${res.status}`);
        const data: any = await res.json();
        return c.json({ success: true, ...(data.result || data) });
      } catch (e) {
        console.error(e);
        return c.json({ success: false, error: "Failed to create tracks" }, 500);
      }
    });

    // --- RENEGOTIATE: kirim answer SDP ---
    this.app.post("/call/renegotiate", async (c) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      try {
        const token = authHeader.replace("Bearer ", "");
        const payload = JSON.parse(atob(token.split(".")[1]));
        const userId = payload.properties?.id || payload.sub;
        if (!userId) return c.json({ success: false, error: "Invalid token" }, 401);

        const appId = this.env.CALL_APP_ID;
        const appSecret = this.env.CALL_APP_SECRET;
        if (!appId || !appSecret) {
          return c.json({ success: false, error: "Call service not configured" }, 500);
        }

        const body: any = await c.req.json().catch(() => ({}));
        const sessionId = body.sessionId;
        const sdp = body.sdp || body.sessionDescription?.sdp || "";
        if (!sessionId || !sdp) {
          return c.json({ success: false, error: "sessionId and sdp required" }, 400);
        }

        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/${sessionId}/renegotiate`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sessionDescription: { type: "answer", sdp } }),
          }
        );
        if (!res.ok) throw new Error(`Renegotiate error: ${res.status}`);
        const data: any = await res.json();
        return c.json({ success: true, ...(data.result || data) });
      } catch (e) {
        console.error(e);
        return c.json({ success: false, error: "Failed to renegotiate" }, 500);
      }
    });

    // --- SIGNALING via DATA_DO, tetep sama, gak diubah ---
    this.app.post("/call/create", async (c) => {
      const callerId = this.getUserId(c);
      if (!callerId) return c.json({ success: false, error: "Unauthorized" }, 401);
      const body: any = await c.req.json().catch(() => ({}));
      const targetId = body.target_user_id || body.targetId || body.receiver_id || "";
      const callType = body.type || "audio";
      const chatId = body.chat_id || body.chatId || "";
      if (!targetId) return c.json({ success: false, error: "target required" }, 400);
      const id = this.env.DATA_DO.idFromName("default");
      const stub = this.env.DATA_DO.get(id);
      const res = await stub.fetch("https://do/call/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": callerId },
        body: JSON.stringify({ target_user_id: targetId, chat_id: chatId || undefined, type: callType }),
      });
      const data: any = await res.json();
      return c.json(data, res.status as any);
    });

    this.app.post("/call/:id/accept", async (c) => {
      const callerId = this.getUserId(c);
      if (!callerId) return c.json({ success: false, error: "Unauthorized" }, 401);
      const callId = c.req.param("id");
      const id = this.env.DATA_DO.idFromName("default");
      const stub = this.env.DATA_DO.get(id);
      const res = await stub.fetch(`https://do/call/${callId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": callerId },
      });
      const data: any = await res.json();
      return c.json(data, res.status as any);
    });

    this.app.post("/call/:id/decline", async (c) => {
      const callerId = this.getUserId(c);
      if (!callerId) return c.json({ success: false, error: "Unauthorized" }, 401);
      const callId = c.req.param("id");
      const id = this.env.DATA_DO.idFromName("default");
      const stub = this.env.DATA_DO.get(id);
      const res = await stub.fetch(`https://do/call/${callId}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": callerId },
      });
      const data: any = await res.json();
      return c.json(data, res.status as any);
    });

    this.app.post("/call/:id/end", async (c) => {
      const callerId = this.getUserId(c);
      if (!callerId) return c.json({ success: false, error: "Unauthorized" }, 401);
      const callId = c.req.param("id");
      const id = this.env.DATA_DO.idFromName("default");
      const stub = this.env.DATA_DO.get(id);
      const res = await stub.fetch(`https://do/call/${callId}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": callerId },
      });
      const data: any = await res.json();
      return c.json(data, res.status as any);
    });

    this.app.post("/call/log", async (c) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      try {
        const token = authHeader.replace("Bearer ", "");
        const payload = JSON.parse(atob(token.split(".")[1]));
        const userId = payload.properties?.id || payload.sub;
        if (!userId) return c.json({ success: false, error: "Invalid token" }, 401);
        await this.ensureTable();
        const { call_id, receiver_id, chat_id, type, status, duration } = await c.req.json();
        if (!call_id || !receiver_id || !status) {
          return c.json({ success: false, error: "call_id, receiver_id and status are required" }, 400);
        }
        await this.env.DATA_DB.prepare(
          `INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(id) DO UPDATE SET status = ?, duration = ?`
        ).bind(call_id, userId, receiver_id, chat_id || null, type || "audio", status, duration || 0, status, duration || 0).run();
        return c.json({ success: true, call_id });
      } catch (e) {
        console.error("Call log error:", e);
        return c.json({ success: false, error: "Failed to save call log" }, 500);
      }
    });

    this.app.get("/call/history", async (c) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      try {
        const token = authHeader.replace("Bearer ", "");
        const payload = JSON.parse(atob(token.split(".")[1]));
        const userId = payload.properties?.id || payload.sub;
        if (!userId) return c.json({ success: false, error: "Invalid token" }, 401);
        await this.ensureTable();
        const history = await this.env.DATA_DB.prepare(
          `SELECT c.*, caller.username as caller_username, caller.yourname as caller_yourname, caller.avatar as caller_avatar, receiver.username as receiver_username, receiver.yourname as receiver_yourname, receiver.avatar as receiver_avatar FROM call_history c LEFT JOIN user caller ON c.caller_id = caller.id LEFT JOIN user receiver ON c.receiver_id = receiver.id WHERE c.caller_id = ? OR c.receiver_id = ? ORDER BY c.created_at DESC LIMIT 50`
        ).bind(userId, userId).all();
        return c.json({ success: true, history: history.results });
      } catch (e) {
        console.error("Call history error:", e);
        return c.json({ success: false, error: "Failed to fetch call history" }, 500);
      }
    });
  }

  public getApp(): Hono { return this.app; }
}
