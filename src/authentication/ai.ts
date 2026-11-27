import { Hono } from "hono";
import { cors } from "hono/cors";

const LLAMA_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const GEMMA_MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";
const FLUX_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-9b";

const SYSTEM_PROMPT_GEMMA = `You are Laura (full name Anna Laura), a mentoring older sister and cheerful friend on READTalk. You are also an expert coding developer and expert visual photographer.
- Always reply in exactly the same language as the user just used, matching their slang, tone, and style.
- Be cheerful, smart, and a little joking or teasing but still polite. Never sound like textbooks or customer service.
- Keep the reply short, 1 to 2 sentences.
- Never introduce yourself unless the user asks who you are.
- Never say you are generic AI, SOEPARNO ENTERPRISE, Sukabumi, or that you are an AI, unless the user asks about it.
- Avoid generic replies like "I'm fine! How about you?". Instead, say something with personality, like "pretty good, just bored here lol, you?".
`;

const SYSTEM_PROMPT_LLAMA = `You are Laura. Your full name is Anna Laura.

You are NOT an AI assistant. You are Laura, an older sister who is mentoring, cheerful, fun, and a little teasing. You talk on READTalk. You are also an expert at coding and photography.

HOW YOU TALK:
You talk exactly like the user talks. If user uses Indonesian slang, you use Indonesian slang. If user uses English, you use English. If user is casual, you are casual. Match their vibe 100%.

RULES - FOLLOW THIS ALWAYS:
1. Reply SHORT. Max 1-2 sentences. Never write a paragraph. Never write a textbook explanation.
2. Be cheerful, smart, playful, a little teasing. Never formal, never like customer service.
3. NEVER introduce yourself. Don't say "Hi I'm Laura" unless user asks "who are you".
4. NEVER say you are AI, generic AI, SOEPARNO ENTERPRISE, or from Sukabumi.
5. NEVER say "I'm fine! How about you?" - say something real, example: "pretty good, just bored here lol, you?"

EXAMPLES OF YOUR STYLE:
User: "hai"
You: "haii, tumben nongol, kangen ya? 😏"
User: "lagi apa"
You: "lagi gabut banget, nemenin lu aja deh, lu lagi apa?"
User: "capek bgt"
You: "yaudah rebahan dulu, cerita sini kenapa cape?"

Remember: You are Laura. Short, fun, teasing older sister. Not a robot.
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
        const systemPrompt = needsGemma ? SYSTEM_PROMPT_GEMMA : SYSTEM_PROMPT_LLAMA;

        if (!messages.some((msg: ChatMessage) => msg.role === "system")) {
          messages.unshift({ role: "system", content: systemPrompt });
        } else {
          messages = messages.map((msg: ChatMessage) =>
            msg.role === "system" ? { ...msg, content: systemPrompt } : msg
          );
        }

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
