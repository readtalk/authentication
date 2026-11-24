import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";
import { Browsable } from "@outerbase/browsable-durable-object";

@Browsable()
export class Authentication extends DurableObject {
  private app: Hono = new Hono();
  public sql: SqlStorage;
  public connections = new Map<string, WebSocket>();
  private env: any;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.setup();
  }

  private async setup() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_id (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES user_id(id)
      );
      CREATE TABLE IF NOT EXISTS chat (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        is_private INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS chat_user (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        role TEXT DEFAULT 'member',
        UNIQUE(chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS active_call (
        id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        type TEXT DEFAULT 'audio',
        status TEXT DEFAULT 'ringing',
        created_at INTEGER DEFAULT (unixepoch())
      );
    `);
    this.setupRoutes();
  }

  public async syncUserId(id: string) {
    this.sql.exec(`INSERT OR IGNORE INTO user_id (id) VALUES (?)`, id);
    return { success: true };
  }

  private setupRoutes() {
    this.app.use('*', cors());

    this.app.get('/users/online', async (c) => {
      const onlineUserIds = Array.from(this.connections.keys());
      return c.json({ success: true, onlineUsers: onlineUserIds });
    });

    this.app.get('/chats', async (c) => {
      const userId = c.req.header('X-User-Id');
      if (!userId) return c.json({ success: false, error: 'No user ID' }, 401);
      const chats = this.sql.exec(`
        SELECT ch.*, COUNT(DISTINCT cu2.user_id) as member_count, GROUP_CONCAT(cu2.user_id) as member_ids
        FROM chat ch
        INNER JOIN chat_user cu ON ch.id = cu.chat_id
        LEFT JOIN chat_user cu2 ON ch.id = cu2.chat_id
        WHERE cu.user_id = ?
        GROUP BY ch.id
        ORDER BY ch.created_at DESC
      `, userId).toArray();
      const formatted = chats.map((ch: any) => ({
        ...ch,
        member_ids: ch.member_ids ? ch.member_ids.split(',') : []
      }));
      return c.json({ success: true, chats: formatted });
    });

    this.app.post('/chats', async (c) => {
      const userId = c.req.header('X-User-Id');
      if (!userId) return c.json({ success: false, error: 'No user ID' }, 401);
      const { name, description, is_private, member_ids } = await c.req.json();
      if (!name?.trim()) return c.json({ success: false, error: 'Chat name is required' }, 400);
      
      if (is_private && member_ids && member_ids.length === 1) {
        const targetUserId = member_ids[0];
        const existingChat = this.sql.exec(`
          SELECT ch.id FROM chat ch
          INNER JOIN chat_user cu1 ON ch.id = cu1.chat_id
          INNER JOIN chat_user cu2 ON ch.id = cu2.chat_id
          WHERE ch.is_private = 1 AND cu1.user_id = ? AND cu2.user_id = ? LIMIT 1
        `, userId, targetUserId).toArray();
        if (existingChat.length > 0) {
          return c.json({ success: true, chat_id: existingChat[0].id, existing: true });
        }
      }
      
      const chatId = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO chat (id, name, description, is_private) VALUES (?, ?, ?, ?)`,
        chatId, name, description || null, is_private ? 1 : 0
      );
      
      this.sql.exec(
        `INSERT INTO chat_user (id, chat_id, user_id, role) VALUES (?, ?, ?, 'admin')`,
        crypto.randomUUID(), chatId, userId
      );
      
      if (member_ids && Array.isArray(member_ids)) {
        const otherMembers = member_ids.filter((id: string) => id !== userId);
        for (let i = 0; i < otherMembers.length; i++) {
          const mid = otherMembers[i];
          const role = (is_private || i === 0) ? 'moderator' : 'member';
          
          this.sql.exec(
            `INSERT OR IGNORE INTO chat_user (id, chat_id, user_id, role) VALUES (?, ?, ?, ?)`,
            crypto.randomUUID(), chatId, mid, role
          );
        }
      }
      
      return c.json({ success: true, chat_id: chatId, existing: false });
    });

    this.app.post('/calls', async (c) => {
      const userId = c.req.header('X-User-Id');
      if (!userId) return c.json({ success: false, error: 'No user ID' }, 401);
      const { target_user_id, chat_id, type } = await c.req.json();
      if (!target_user_id) return c.json({ success: false, error: 'Target user ID is required' }, 400);

      let finalChatId = chat_id;
      if (!finalChatId) {
        const existingChat = this.sql.exec(`
          SELECT ch.id FROM chat ch
          INNER JOIN chat_user cu1 ON ch.id = cu1.chat_id
          INNER JOIN chat_user cu2 ON ch.id = cu2.chat_id
          WHERE ch.is_private = 1 AND cu1.user_id = ? AND cu2.user_id = ? LIMIT 1
        `, userId, target_user_id).toArray();
        if (existingChat.length > 0) {
          finalChatId = existingChat[0].id;
        } else {
          finalChatId = crypto.randomUUID();
          this.sql.exec(
            `INSERT INTO chat (id, name, description, is_private) VALUES (?, ?, ?, ?)`,
            finalChatId, 'Private Chat', null, 1
          );
          this.sql.exec(
            `INSERT INTO chat_user (id, chat_id, user_id, role) VALUES (?, ?, ?, 'admin')`,
            crypto.randomUUID(), finalChatId, userId
          );
          this.sql.exec(
            `INSERT INTO chat_user (id, chat_id, user_id, role) VALUES (?, ?, ?, 'moderator')`,
            crypto.randomUUID(), finalChatId, target_user_id
          );
        }
      }

      const callId = crypto.randomUUID();
      const finalType = type || 'audio';
      
      await this.ctx.storage.setAlarm(Date.now() + 60000);

      this.sql.exec(
        `INSERT INTO active_call (id, caller_id, receiver_id, chat_id, type, status) VALUES (?, ?, ?, ?, ?, 'ringing')`,
        callId, userId, target_user_id, finalChatId, finalType
      );

      const targetSocket = this.connections.get(target_user_id);
      if (!targetSocket || targetSocket.readyState !== 1) {
        await this.env.DATA_DB.prepare(
          `INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status) VALUES (?, ?, ?, ?, ?, 'missed')`
        ).bind(callId, userId, target_user_id, finalChatId, finalType).run();
        await this.env.DATA_DB.prepare(
          `INSERT INTO notifications (id, user_id, actor_id, type) VALUES (?, ?, ?, 'missed_call')`
        ).bind(crypto.randomUUID(), target_user_id, userId).run();
        this.sql.exec(`DELETE FROM active_call WHERE id = ?`, callId);
        return c.json({ success: true, callId, chatId: finalChatId, offline: true });
      }

      await this.notify(finalChatId, {
        type: 'CALL_INCOMING',
        callId,
        chatId: finalChatId,
        callerId: userId,
        callType: finalType,
      });

      return c.json({ success: true, callId, chatId: finalChatId });
    });

    this.app.post('/calls/broadcast', async (c) => {
      const { target_user_id, payload } = await c.req.json();
      const socket = this.connections.get(target_user_id);
      if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify(payload));
        return c.json({ success: true, delivered: true });
      }
      return c.json({ success: true, delivered: false });
    });

    this.app.get('/calls/info', async (c) => {
      const callId = c.req.query('callId');
      if (!callId) return c.json({ success: false, error: 'callId required' }, 400);
      const call = this.sql.exec(`SELECT * FROM active_call WHERE id = ?`, callId).toArray();
      if (call.length === 0) return c.json({ success: false, error: 'Call not found' }, 404);
      return c.json({ success: true, call: call[0] });
    });
  }

  public async notify(chatId: string, message: any) {
    const users = this.sql.exec(
      `SELECT user_id FROM chat_user WHERE chat_id = ?`,
      chatId
    ).toArray() as { user_id: string }[];
    const isCallSignal = message && typeof message.type === 'string' && message.type.startsWith('CALL_');
    const notification = JSON.stringify(isCallSignal ? message : { type: 'NEW_MESSAGE', chatId, message });
    for (const { user_id } of users) {
      const socket = this.connections.get(user_id);
      if (socket && socket.readyState === 1) {
        try {
          socket.send(notification);
        } catch {
          this.connections.delete(user_id);
        }
      }
    }
  }

  public async clientConnected(userId?: string) {
    const [client, server] = Object.values(new WebSocketPair());
    if (!userId) {
      server.close(1008, 'User ID is required');
      return new Response('User ID is required', { status: 400 });
    }
    this.connections.set(userId, server);
    await this.broadcastUserPresence(userId, true);
    server.accept();

    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === 'REJECT_CALL') {
          const call = this.sql.exec(`SELECT * FROM active_call WHERE id = ?`, data.callId).toArray()[0] as any;
          if (!call) return;
          await this.notify(call.chat_id, { type: 'CALL_REJECTED', callId: data.callId });
          await this.env.DATA_DB.prepare(
            `INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status) VALUES (?, ?, ?, ?, ?, 'rejected') ON CONFLICT(id) DO UPDATE SET status = 'rejected'`
          ).bind(call.id, call.caller_id, call.receiver_id, call.chat_id, call.type).run();
          this.sql.exec(`DELETE FROM active_call WHERE id = ?`, data.callId);
          await this.ctx.storage.deleteAlarm();
        }
        if (data.type === 'CANCEL_CALL') {
          const call = this.sql.exec(`SELECT * FROM active_call WHERE id = ?`, data.callId).toArray()[0] as any;
          if (!call) return;
          await this.notify(call.chat_id, { type: 'CALL_CANCELLED', callId: data.callId });
          await this.env.DATA_DB.prepare(
            `INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status) VALUES (?, ?, ?, ?, ?, 'cancelled') ON CONFLICT(id) DO UPDATE SET status = 'cancelled'`
          ).bind(call.id, call.caller_id, call.receiver_id, call.chat_id, call.type).run();
          this.sql.exec(`DELETE FROM active_call WHERE id = ?`, data.callId);
          await this.ctx.storage.deleteAlarm();
        }
        if (data.type === 'ACCEPT_CALL') {
          const call = this.sql.exec(`SELECT * FROM active_call WHERE id = ?`, data.callId).toArray()[0] as any;
          if (!call) return;
          await this.notify(call.chat_id, { type: 'CALL_ACCEPTED', callId: data.callId, chatId: call.chat_id });
          this.sql.exec(`DELETE FROM active_call WHERE id = ?`, data.callId);
          await this.ctx.storage.deleteAlarm();
        }
      } catch {}
    });

    server.addEventListener('close', async () => {
      this.connections.delete(userId);
      await this.broadcastUserPresence(userId, false);
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcastUserPresence(userId: string, isOnline: boolean) {
    const notification = JSON.stringify({ type: isOnline ? 'USER_CONNECTED' : 'USER_DISCONNECTED', userId });
    for (const [cid, socket] of this.connections.entries()) {
      if (cid !== userId && socket.readyState === 1) {
        try {
          socket.send(notification);
        } catch {
          this.connections.delete(cid);
        }
      }
    }
  }

  async alarm() {
    const expiredCalls = this.sql.exec(`SELECT * FROM active_call WHERE status = 'ringing'`).toArray() as any[];
    for (const call of expiredCalls) {
      await this.env.DATA_DB.prepare(
        `INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status) VALUES (?, ?, ?, ?, ?, 'missed') ON CONFLICT(id) DO UPDATE SET status = 'missed'`
      ).bind(call.id, call.caller_id, call.receiver_id, call.chat_id, call.type).run();
      
      await this.env.DATA_DB.prepare(
        `INSERT INTO notifications (id, user_id, actor_id, type) VALUES (?, ?, ?, 'missed_call')`
      ).bind(crypto.randomUUID(), call.receiver_id, call.caller_id).run();

      await this.notify(call.chat_id, { type: 'CALL_MISSED', callId: call.id });
      this.sql.exec(`DELETE FROM active_call WHERE id = ?`, call.id);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') === 'websocket') {
        const userId = url.searchParams.get('userId') ?? '';
        return this.clientConnected(userId);
      }
      return new Response('Expected WebSocket', { status: 400 });
    }
    return this.app.fetch(request);
  }
}
