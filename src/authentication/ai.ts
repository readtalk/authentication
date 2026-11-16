//
import { Hono } from "hono";
import { cors } from "hono/cors";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

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
