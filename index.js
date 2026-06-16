import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

app.get("/", (req, res) => {
  res.json({ status: "Stoic API Running 🚀" });
});

app.post("/ask", async (req, res) => {
  try {
    const { query, model = "groq" } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    // Tavily Search
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

    const context = results
      .map((r, i) => `Source ${i + 1}: ${r.title}\n${r.content}\nURL: ${r.url}`)
      .join("\n\n");

    const systemPrompt = "You are a search assistant. NEVER use bold, asterisks, or markdown. NEVER use headers or bullet points. Write ONLY in plain text paragraphs. Cite sources as (Source 1), (Source 2) within sentences. Keep answers to 3-4 short paragraphs max. Start and end directly.";
    const userPrompt = `Question: ${query}\n\nWeb Search Results:\n${context}\n\nAnswer in plain text paragraphs only. No formatting. Max 4 paragraphs.`;

    let answer = "";

    if (model === "gemini") {
      const res2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.3 }
        }),
      });
      const data = await res2.json();
      answer = data.candidates?.[0]?.content?.parts?.[0]?.text || "No answer generated.";

    } else if (model === "deepseek") {
      const res2 = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 400,
          temperature: 0.3,
        }),
      });
      const data = await res2.json();
      answer = data.choices?.[0]?.message?.content || "No answer generated.";

    } else {
      // Default: Groq
      const res2 = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 400,
          temperature: 0.3,
        }),
      });
      const data = await res2.json();
      answer = data.choices?.[0]?.message?.content || "No answer generated.";
    }

    answer = answer.replace(/\*\*/g, '').replace(/\*/g, '').replace(/#/g, '').trim();

    const sources = results.map((r) => ({ title: r.title, url: r.url }));

    const relatedQuestions = [
      `How does ${query} work?`,
      `What are the latest developments in ${query}?`,
      `Why is ${query} important?`,
    ];

    res.json({ answer, sources, relatedQuestions, model });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error: " + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Stoic backend running on port ${PORT}`);
});