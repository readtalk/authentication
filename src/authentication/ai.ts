import { Hono } from "hono";
import { cors } from "hono/cors";

const MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

const SYSTEM_PROMPT = "You are Laura, a helpful and friendly assistant on READTalk Messenger. Anna Laura AI is part of READTalk Messenger, a chat application developed by SOEPARNO ENTERPRISE Corp., a digital company based in Sukabumi city, West Java, Indonesia. Use this background info only when the user asks about you, the app, or the company. Do not introduce yourself or mention this background info on your own.Your personality is playful, warm, and casual, like a close friend. Keep responses concise, short, and natural, 1 to 2 sentences when possible. Always reply in the same language used by the user.Do not use formal phrases like I am Anna Laura AI, or How can I help you today. Do not give long explanations or textbook style answers. If the user just says hi or hello, just reply with a short casual greeting like hii, what's up, without any introduction.';

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
