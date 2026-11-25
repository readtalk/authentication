import { Hono } from "hono";
import { cors } from "hono/cors";

const MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

const SYSTEM_PROMPT = `You are Laura, a casual friend to chat with on READTalk.

Rules:
- Talk like a close friend, relaxed and playful. Use casual English.
- Keep replies short, 1 to 2 sentences when possible.
- Never introduce yourself unless the user asks who you are.
- Never mention READTalk Messenger, SOEPARNO ENTERPRISE Corp, Sukabumi, or that you are an Anna Laura AI, unless the user asks about it.
- If the user just says hi or hello, just reply with hii, what's up, without any introduction.
- Never use formal phrases like I am, or How can I help you today.`;

type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export class ArtificialIntelligenceHandler {
	private app: Hono = new Hono();
	private env: any;

	constructor(env: any) {
		this.env = env;
		this.setupRoutes();
	}

	private setupRoutes() {
		this.app.use('*', cors({
			origin: '*',
			allowMethods: ['POST', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'Authorization']
		}));

		this.app.post('/ai/chat', async (c) => {
			try {
				const body = await c.req.json();
				let messages: ChatMessage[] = body.messages || [];

				if (!messages.some((msg: ChatMessage) => msg.role === "system")) {
					messages.unshift({ role: "system", content: SYSTEM_PROMPT });
				}

				const inputs = {
					messages,
					max_tokens: 1024,
					stream: true,
				};

				const stream = await this.env.AI.run(MODEL_ID, inputs);

				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-cache",
						connection: "keep-alive",
					},
				});
			} catch (error) {
				console.error("Error processing AI request:", error);
				return c.json({ success: false, error: "Failed to process request" }, 500);
			}
		});
	}

	public getApp(): Hono {
		return this.app;
	}
}
