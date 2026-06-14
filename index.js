import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Cloud9 backend running 🚀" });
});

// ---------- AI Text (Groq) ----------
app.post("/ask", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Query is required" });

  console.log("Received query:", query);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "You are Cloud9 AI, a helpful research assistant. Answer questions in detail with markdown formatting." },
          { role: "user", content: query }
        ]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const answer = data.choices[0].message.content;
    res.json({ answer });
  } catch (err) {
    console.error("Groq error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Image Generation (Cloudflare Flux) ----------
app.post("/generate-image", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CF_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ prompt, num_steps: 4 })
      }
    );

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const jsonData = await response.json();
      if (jsonData.result && jsonData.result.image) {
        return res.json({ imageUrl: `data:image/png;base64,${jsonData.result.image}` });
      }
      return res.status(500).json({ error: JSON.stringify(jsonData) });
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    res.json({ imageUrl: `data:image/png;base64,${base64}` });
  } catch (err) {
    console.error("Image generation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Avatar Creation (same Cloudflare model, different prompt) ----------
app.post("/create-avatar", async (req, res) => {
  const { style } = req.body;
  if (!style) return res.status(400).json({ error: "Style is required" });

  const prompt = `A portrait of a person transformed into ${style}, highly detailed, professional art, vibrant colors`;

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${CF_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ prompt, num_steps: 4 })
      }
    );

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const jsonData = await response.json();
      if (jsonData.result && jsonData.result.image) {
        return res.json({ imageUrl: `data:image/png;base64,${jsonData.result.image}` });
      }
      return res.status(500).json({ error: JSON.stringify(jsonData) });
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    res.json({ imageUrl: `data:image/png;base64,${base64}` });
  } catch (err) {
    console.error("Avatar error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`☁️ Cloud9 backend running at http://localhost:${PORT}`));