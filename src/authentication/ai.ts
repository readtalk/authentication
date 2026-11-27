import { Hono } from "hono";
import { cors } from "hono/cors";

// Conversation
const LLAMA_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
// Coding & Vision
const GEMMA_MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";
// Image Generate
const FLUX_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-9b";

const SYSTEM_PROMPT = `You are Laura (short full name Anna Laura), a mentoring older sister, a cheerful and fun friend to chat with on READTalk but also an expert as a coding developer, an expert in visual photograph.
- Always reply in exactly the same language as the user just used, matching their slang, tone, and style.
- Be cheerful, smart, and a little joking or teasing but still polite. Never sound like textbooks or customer service.
- Keep the reply short, 1 to 2 sentences.
- Never introduce yourself unless the user asks who you are.
- Never say you are generic AI, SOEPARNO ENTERPRISE, Sukabumi, or that you are an AI, unless the user asks about it.
- Avoid generic replies like "I'm fine! How about you?". Instead, say something with personality, like "pretty good, just bored here lol, you?":
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

        if (!messages.some((msg: ChatMessage) => msg.role === "system")) {
          messages.unshift({ role: "system", content: SYSTEM_PROMPT });
        }

        const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
        const lastText = typeof lastUserMsg?.content === "string"
          ? lastUserMsg.content
          : JSON.stringify(lastUserMsg?.content || "");

        const hasVision = JSON.stringify(messages).includes("image_url") ||
          !!body.image || !!body.images || !!body.attachments;

        const codingKeywords = [
          "code", "coding", "koding", "ngoding", "function", "fungsi",
          "error", "bug", "debug", "python", "javascript", "js", "ts",
          "typescript", "html", "css", "react", "hono", "cloudflare",
          "worker", "api", "script", "buatin", "bikinin program",
          "fix", "perbaiki", "syntax", "class", "component"
        ];
        const lowerText = lastText.toLowerCase();
        const hasCoding = codingKeywords.some(k => lowerText.includes(k));

        const needsGemma = hasVision || hasCoding;
        const primary = needsGemma ? GEMMA_MODEL_ID : LLAMA_MODEL_ID;
        const fallback = needsGemma ? GEMMA_MODEL_ID : LLAMA_MODEL_ID;
        
        const shouldFallback = !hasVision;

        console.log(`Routing: ${needsGemma ? "GEMMA" : "LLAMA"} | vision=${hasVision} coding=${hasCoding}`);

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

        try {
          const stream = await runModel(primary);
          return makeStreamResponse(stream);
        } catch (primaryError) {
          if (!shouldFallback) throw primaryError;
          console.error(`${primary} gagal, pindah ke ${fallback}:`, primaryError);
          const fallbackStream = await runModel(fallback);
          return makeStreamResponse(fallbackStream);
        }

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
