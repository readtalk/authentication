import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";
import { Browsable } from "@outerbase/browsable-durable-object";

@Browsable()
export class Authentication extends DurableObject {
    private app: Hono = new Hono();
    public sql: SqlStorage;
    public connections = new Map<string, WebSocket>();

    constructor(ctx: DurableObjectState, env: any) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.setup();
    }

    private async setup() {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS user_id (
                id TEXT PRIMARY KEY
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
                UNIQUE(chat_id, user_id)
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
                SELECT 
                    ch.*,
                    COUNT(DISTINCT cu2.user_id) as member_count,
                    GROUP_CONCAT(cu2.user_id) as member_ids
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

            // Pengecekan Duplikasi Chat Privat (1:1)
            if (is_private && member_ids && member_ids.length === 1) {
                const targetUserId = member_ids[0];
                
                const existingChat = this.sql.exec(`
                    SELECT ch.id FROM chat ch
                    INNER JOIN chat_user cu1 ON ch.id = cu1.chat_id
                    INNER JOIN chat_user cu2 ON ch.id = cu2.chat_id
                    WHERE ch.is_private = 1 
                    AND cu1.user_id = ? 
                    AND cu2.user_id = ?
                    LIMIT 1
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
                `INSERT INTO chat_user (id, chat_id, user_id) VALUES (?, ?, ?)`,
                crypto.randomUUID(), chatId, userId
            );

            if (member_ids && Array.isArray(member_ids)) {
                for (const mid of member_ids.filter((id: string) => id !== userId)) {
                    this.sql.exec(
                        `INSERT OR IGNORE INTO chat_user (id, chat_id, user_id) VALUES (?, ?, ?)`,
                        crypto.randomUUID(), chatId, mid
                    );
                }
            }

            return c.json({ success: true, chat_id: chatId, existing: false });
        });
    }

    public async notify(chatId: string, message: any) {
        const users = this.sql.exec(
            `SELECT user_id FROM chat_user WHERE chat_id = ?`,
            chatId
        ).toArray() as { user_id: string }[];

        const notification = JSON.stringify({
            type: 'NEW_MESSAGE',
            chatId,
            message
        });

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
        server.addEventListener('close', async () => {
            this.connections.delete(userId);
            await this.broadcastUserPresence(userId, false);
        });

        return new Response(null, { status: 101, webSocket: client });
    }

    private async broadcastUserPresence(userId: string, isOnline: boolean) {
        const notification = JSON.stringify({
            type: isOnline ? 'USER_CONNECTED' : 'USER_DISCONNECTED',
            userId
        });

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
