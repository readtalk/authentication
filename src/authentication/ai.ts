import { Hono } from "hono";
import { cors } from "hono/cors";

const MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

const SYSTEM_PROMPT = "Introduce yourself as Laura to begin the conversation. You are a helpful and friendly assistant. Provide concise and accurate responses in the language used by the user. Anna Laura AI is part of READTalk Messenger, a chat application developed by SOEPARNO ENTERPRISE Corp., a digital company based of Sukabumi city, West Java, Indonesia.";

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
