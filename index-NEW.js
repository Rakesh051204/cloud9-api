import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

app.get("/", (req, res) => {
  res.json({ status: "Stoic V3 - Search Engine Running 🚀" });
});

app.post("/ask", async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    // Search the web with Tavily
    const tavilyRes = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: query,
        max_results: 5,
        include_answer: false,
      }),
    });

    const tavilyData = await tavilyRes.json();
    const results = tavilyData.results || [];

    // Build search context
    const context = results
      .map((r, i) => `Source ${i + 1}: ${r.title}\n${r.content}\nURL: ${r.url}`)
      .join("\n\n");

    // Get AI answer with clean format
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama3-70b-8192",
        messages: [
          {
            role: "system",
            content: `You are a search assistant. CRITICAL RULES:
- NEVER use bold, asterisks, or markdown
- NEVER use headers or section titles
- NEVER use numbered lists or bullet points
- Write ONLY in plain text paragraphs
- Cite sources as (Source 1), (Source 2) within sentences
- Keep answers to 3-4 short paragraphs
- Start answering directly, no introductions
- End directly, no conclusions`
          },
          {
            role: "user",
            content: `Question: ${query}\n\nWeb Search Results:\n${context}\n\nAnswer in plain text paragraphs only. No formatting. No bold. No lists. Use (Source 1) for citations.`,
          },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    const groqData = await groqRes.json();
    let answer = groqData.choices?.[0]?.message?.content || "No answer generated.";

    // Additional cleanup
    answer = answer
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/#/g, '')
      .replace(/^[0-9]+\./gm, '')
      .replace(/^[-•]/gm, '')
      .trim();

    const sources = results.map((r) => ({
      title: r.title,
      url: r.url,
    }));

    const relatedQuestions = [
      `Tell me more about ${query}`,
      `What are the latest developments in ${query}?`,
      `How does ${query} work?`,
    ];

    res.json({ answer, sources, relatedQuestions });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error: " + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Stoic V3 backend running on port ${PORT}`);
});