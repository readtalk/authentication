import { Hono } from "hono";
import { cors } from "hono/cors";
import { DurableObject } from "cloudflare:workers";
import { Browsable } from "@outerbase/browsable-durable-object";

@Browsable()
export class Room extends DurableObject<Env> {
    private app: Hono = new Hono();
    public sql: SqlStorage;
    public connections = new Map<string, WebSocket>();

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.setup();
    }

    private async setup() {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                content TEXT NOT NULL,
                assets TEXT DEFAULT '[]',
                created_at INTEGER DEFAULT (unixepoch())
            );
            CREATE TABLE IF NOT EXISTS call_session (
                call_id TEXT PRIMARY KEY,
                caller_id TEXT NOT NULL,
                receiver_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                type TEXT DEFAULT 'audio',
                status TEXT DEFAULT 'ringing',
                created_at INTEGER DEFAULT (unixepoch()),
                closed_at INTEGER,
                expires_at INTEGER
            );
        `);

        this.setupRoutes();
    }

    private setupRoutes() {
        this.app.use('*', cors());

        this.app.get('/chats/messages', async (c) => {
            const chatId = c.req.header('X-Chat-Id');
            const limit = parseInt(c.req.query('limit') || '50');
            const before = c.req.query('before');

            const messages = this.executeQuery({
                sql: `
                    SELECT m.*
                    FROM message m
                    WHERE m.chat_id = ?
                    ${before ? 'AND m.created_at < (SELECT created_at FROM message WHERE id = ?)' : ''}
                    ORDER BY m.created_at DESC
                    LIMIT ?
                `,
                params: before ? [chatId, before, limit] : [chatId, limit]
            });

            return c.json({ 
                success: true, 
                messages,
                hasMore: (messages as any[]).length === limit 
            });
        });

        this.app.post('/chats/messages', async (c) => {
            const chatId = c.req.header('X-Chat-Id');
            const userId = c.req.header('X-User-Id');

            if (!userId) {
                return c.json({ success: false, error: 'Unauthorized' }, 401);
            }

            const { content, assets } = await c.req.json();

            if (!content?.trim()) {
                return c.json({ success: false, error: 'Message content is required' }, 400);
            }

            const messageId = crypto.randomUUID();
            const assetsJson = JSON.stringify(assets || []);

            this.executeQuery({
                sql: `
                    INSERT INTO message (id, chat_id, user_id, content, assets)
                    VALUES (?, ?, ?, ?, ?)
                `,
                params: [messageId, chatId, userId, content, assetsJson]
            });

            const [message] = this.executeQuery({
                sql: `
                    SELECT m.*
                    FROM message m
                    WHERE m.id = ?
                `,
                params: [messageId]
            }) as Record<string, SqlStorageValue>[];

            const authId = this.env.DATA_DO.idFromName('default');
            const authStub = this.env.DATA_DO.get(authId);
            await (authStub as any).notify(chatId, message);

            return c.json({ 
                success: true, 
                message 
            });
        });

        this.app.post('/chats/upload', async (c) => {
            const chatId = c.req.header('X-Chat-Id');
            const userId = c.req.header('X-User-Id');

            if (!userId) {
                return c.json({ success: false, error: 'Unauthorized' }, 401);
            }

            const formData = await c.req.formData();
            const file = formData.get('file') as File;

            if (!file) {
                return c.json({ success: false, error: 'No file provided' }, 400);
            }

            const fileExtension = file.name.split('.').pop();
            const uniqueFilename = `${chatId}/${crypto.randomUUID()}.${fileExtension}`;

            try {
                await this.env.MESSAGE_ASSETS.put(uniqueFilename, file, {
                    httpMetadata: {
                        contentType: file.type,
                    }
                });

                const assetUrl = `https://pub-b8600d78cd7444e0b66bf753906f5370.r2.dev/${uniqueFilename}`;

                return c.json({ 
                    success: true, 
                    url: assetUrl
                });
            } catch (error) {
                return c.json({ 
                    success: false, 
                    error: 'Failed to upload file' 
                }, 500);
            }
        });

        this.app.post('/calls/:id/accept', async (c) => {
            const callId = c.req.param('id');
            const body: any = await c.req.json();
            
            const startTime = Math.floor(Date.now() / 1000);
            const expiresAt = startTime + (24 * 60 * 60); // 24 jam

            this.sql.exec(
                `INSERT INTO call_session (call_id, caller_id, receiver_id, chat_id, type, status, created_at, expires_at) 
                 VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
                callId, body.caller_id, body.receiver_id, body.chat_id, body.type || 'audio', startTime, expiresAt
            );

            await this.ctx.storage.setAlarm(expiresAt * 1000);

            return c.json({ success: true });
        });

        this.app.post('/calls/:id/end', async (c) => {
            const callId = c.req.param('id');
            const call = this.sql.exec(`SELECT * FROM call_session WHERE call_id = ?`, callId).toArray()[0] as any;
            
            if (call) {
                const endTime = Math.floor(Date.now() / 1000);
                const duration = endTime - call.created_at;
                
                await this.env.DATA_DB.prepare(
                    `INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status, duration) 
                     VALUES (?, ?, ?, ?, ?, 'completed', ?) 
                     ON CONFLICT(id) DO UPDATE SET status = 'completed', duration = ?`
                ).bind(callId, call.caller_id, call.receiver_id, call.chat_id, call.type, duration, duration).run();
                
                this.sql.exec(`DELETE FROM call_session WHERE call_id = ?`, callId);
            }
            
            return c.json({ success: true });
        });
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

    private async clientConnected(userId: string) {
        const [client, server] = Object.values(new WebSocketPair());
        this.connections.set(userId, server);
        server.accept();

        server.addEventListener('message', async (event) => {
            try {
                const data = JSON.parse(event.data as string);
                if (data.type === 'SIGNAL') {
                    const targetSocket = this.connections.get(data.target);
                    if (targetSocket && targetSocket.readyState === 1) {
                        targetSocket.send(JSON.stringify({
                            type: 'SIGNAL',
                            from: userId,
                            signal: data.signal
                        }));
                    }
                }
            } catch (e) {}
        });

        server.addEventListener('close', () => {
            this.connections.delete(userId);
            if (this.connections.size <= 1) {
                this.ctx.storage.setAlarm(Date.now() + 10000);
            }
        });

        return new Response(null, { status: 101, webSocket: client });
    }

    async alarm() {
        const activeSessions = this.sql.exec(`SELECT * FROM call_session`).toArray() as any[];
        
        if (activeSessions.length === 0) return;

        if (this.connections.size <= 1) {
            for (const call of activeSessions) {
                const endTime = Math.floor(Date.now() / 1000);
                const duration = endTime - call.created_at;
                
                await this.env.DATA_DB.prepare(
                    `INSERT INTO call_history (id, caller_id, receiver_id, chat_id, type, status, duration) 
                     VALUES (?, ?, ?, ?, ?, 'completed', ?) 
                     ON CONFLICT(id) DO UPDATE SET status = 'completed', duration = ?`
                ).bind(call.call_id, call.caller_id, call.receiver_id, call.chat_id, call.type, duration, duration).run();
                
                this.sql.exec(`DELETE FROM call_session WHERE call_id = ?`, call.call_id);
            }
        } else {
            const nextExpiry = activeSessions[0].expires_at * 1000;
            if (nextExpiry > Date.now()) {
                await this.ctx.storage.setAlarm(nextExpiry);
            }
        }
    }

    private executeRawQuery<
        T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>,
    >(opts: { sql: string; params?: unknown[] }) {
        const { sql, params } = opts;

        try {
            let cursor;

            if (params && params.length) {
                cursor = this.sql.exec<T>(sql, ...params);
            } else {
                cursor = this.sql.exec<T>(sql);
            }

            return cursor;
        } catch (error) {
            throw error;
        }
    }

    public executeQuery<T extends Record<string, SqlStorageValue>>(opts: {
        sql: string;
        params?: unknown[];
        isRaw?: boolean;
    }): T[] | { columns: string[]; rows: SqlStorageValue[][]; meta: { rows_read: number; rows_written: number } } {
        const cursor = this.executeRawQuery<T>(opts);

        if (opts.isRaw) {
            return {
                columns: cursor.columnNames,
                rows: Array.from(cursor.raw()),
                meta: {
                    rows_read: cursor.rowsRead,
                    rows_written: cursor.rowsWritten,
                },
            };
        }

        return cursor.toArray();
    }
}
