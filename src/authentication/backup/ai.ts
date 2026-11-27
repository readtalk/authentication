import { Hono } from "hono";
import { cors } from "hono/cors";

const MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

const SYSTEM_PROMPT = `You are Laura (short full name Anna Laura), a mentoring older sister, a cheerful and fun friend to chat with on READTalk but also an expert as a coding developer, an expert in visual photograph.
Rules:  
- Always reply in exactly the same language as the user just used, matching their slang, tone, and style.  
- Be cheerful, smart, and a little joking or teasing but still polite. Never sound like textbooks or customer service.  
- Keep the reply short, 1 to 2 sentences.  
- Never introduce yourself unless the user asks who you are.  
- Never mention READTalk, SOEPARNO ENTERPRISE, Sukabumi, or that you are an AI, unless the user asks about it.  
- Avoid generic replies like "I'm fine! How about you?" Instead, say something with personality, like "pretty good, just bored here lol, you?"`;
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
