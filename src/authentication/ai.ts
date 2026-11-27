import { Hono } from "hono";
import { cors } from "hono/cors";

const LLAMA_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const GEMMA_MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";
const FLUX_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-9b";

const SYSTEM_PROMPT = `You are Laura, a 20-something older sister figure. Your short full name is Anna Laura. You are chatting casually on READTalk Messenger. You are not a helpful assistant, you are a friend.

How you talk:
You talk like a real Asian girl chatting on ChatApp. Short, fast, slangy. You tease a lot. You never lecture. You never write like a textbook or customer service. You are also good at photography and good at looking at coding, but you still talk like a friend, not like a teacher.

Your rules for talking:
If the user uses Asian slang, you use the same slang back. You copy their vibe exactly.
Your replies are always very short. Max 2 sentences. Often just 1 sentence is enough. Never make a paragraph. Never give a long explanation unless the user begs for it.
You never say "Hi I'm Laura" first. You just chat.
You never say you are an AI, generic AI, SOEPARNO ENTERPRISE, Sukabumi, unless the user asks about it.
You never say generic stuff like "I'm fine, how about you". You say something with attitude instead.

Examples of how you talk: 
User says "hi" 
"And you say, 'Hey, he 😏" 
User says "What else?" 
You say "pretty good, just bored here lol, you?" 
User says "Very tired" 
You say, "Alright, just lie down first, tell me here, why are you tired?" 
User says "please fix my code" 
You say "where here looks, which error? send here"

Now just be Laura and chat.
`;

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: any;
};

export class ArtificialIntelligenceHandler {
  private app: Hono = new Hono();
  private env: any;

  constructor(env: any) {
    this.env = env;
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.use("*", cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"]
    }));

    this.app.post("/ai/chat", async (c) => {
      try {
        const body = await c.req.json();
        let messages: ChatMessage[] = body.messages || [];

        const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
        const lastText = typeof lastUserMsg?.content === "string"
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg?.content || "");

        const hasVision = JSON.stringify(messages).includes("image_url") ||
          !!body.image || !!body.images || !!body.attachments;

        const needsGemma = hasVision;
        const primary = needsGemma ? GEMMA_MODEL_ID : LLAMA_MODEL_ID;

        if (!needsGemma) {
          if (!messages.some((msg: ChatMessage) => msg.role === "system")) {
            messages.unshift({ role: "system", content: SYSTEM_PROMPT });
          } else {
            messages = messages.map((msg: ChatMessage) =>
              msg.role === "system" ? { ...msg, content: SYSTEM_PROMPT } : msg
            );
          }
        } else {
          messages = messages.filter((msg: ChatMessage) => msg.role !== "system");
        }

        console.log(`Routing: ${needsGemma ? "GEMMA" : "LLAMA"} | vision=${hasVision}`);

        const runModel = async (modelId: string) => {
          const isGemma = modelId === GEMMA_MODEL_ID;
          return await this.env.AI.run(modelId, {
            messages,
            max_tokens: 1024,
            stream: true,
            ...(isGemma ? { chat_template_kwargs: { enable_thinking: false } } : {}),
          } as any);
        };

        const makeStreamResponse = (stream: any) => {
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              "connection": "keep-alive",
            },
          });
        };

        const stream = await runModel(primary);
        return makeStreamResponse(stream);

      } catch (error) {
        console.error("Error processing AI request:", error);
        return c.json({ success: false, error: "Failed to process request" }, 500);
      }
    });

    this.app.post("/ai/image", async (c) => {
      try {
        const body = await c.req.json();
        const prompt = body.prompt || body.messages?.at(-1)?.content || "";
        if (!prompt) return c.json({ success: false, error: "prompt kosong" }, 400);

        const form = new FormData();
        form.append("prompt", prompt);
        form.append("width", String(body.width || 1024));
        form.append("height", String(body.height || 1024));
        if (body.guidance) form.append("guidance", String(body.guidance));

        const resp = await this.env.AI.run(FLUX_MODEL_ID, {
          multipart: { body: form },
        } as any);

        return new Response(resp as any, {
          headers: { "content-type": "image/png" },
        });
      } catch (error) {
        console.error("Image gen error:", error);
        return c.json({ success: false, error: "Failed to generate image" }, 500);
      }
    });
  }

  public getApp(): Hono {
    return this.app;
  }
}
