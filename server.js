import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { tavily } from '@tavily/core';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/test', (req, res) => res.json({ test: "route works" }));

app.get('/', (req, res) => {
  res.json({ status: 'Cloud9 backend running 🚀' });
});

// ---------- ORIGINAL AI CHAT (Groq) ----------
app.post('/ask', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are Cloud9 AI, a helpful assistant.' },
          { role: 'user', content: query }
        ]
      })
    });
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || 'No response from AI';
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- WEB SEARCH + AI (Tavily + Groq) ----------
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

app.post('/ask-with-web', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });

  try {
    const searchResult = await tvly.search(query, {
      max_results: 5,
      include_answer: true,
      include_raw_content: true,
    });

    const sources = searchResult.results.map((r, i) => ({
      id: i + 1,
      title: r.title,
      url: r.url,
      content: r.raw_content?.slice(0, 1500) || r.content
    }));

    const context = sources.map(s =>
      `Source [${s.id}]: ${s.title}\nURL: ${s.url}\n${s.content}`
    ).join('\n\n');

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Answer using ONLY the sources. Cite as [1], [2]. If sources lack info, say so.'
          },
          { role: 'user', content: `Sources:\n${context}\n\nQuestion: ${query}` }
        ]
      })
    });

    const data = await groqRes.json();
    const answer = data.choices?.[0]?.message?.content || 'No answer from AI';
    res.json({ answer, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ENHANCED SEARCH WITH RICH STRUCTURED ANSWERS (using Groq) ----------
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    // 1. Search using Tavily
    const searchResult = await tvly.search(query, {
      max_results: 5,
      include_answer: true,
      include_raw_content: true,
    });

    const sources = searchResult.results.map((r, i) => ({
      title: r.title,
      url: r.url,
    }));

    const context = searchResult.results
      .map((r, i) => `Source [${i + 1}]: ${r.title}\nURL: ${r.url}\n${r.raw_content?.slice(0, 1500) || r.content}`)
      .join('\n\n');

    // 2. Use Groq to generate a rich, structured answer
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are Stoic, a helpful AI assistant. Answer the user's question using ONLY the provided sources.

Format your answer with:

✅ Simple Answer: (2-3 sentences)

**Detailed Explanation:** (multiple paragraphs, as needed)

📊 Key Points: (a table if the information is list-like, otherwise bullet points)

💻 Code Example: (if relevant to the question, provide working code)

Provide citations using [1], [2] etc. that refer to the sources listed below.`
          },
          { role: 'user', content: `Sources:\n${context}\n\nQuestion: ${query}` }
        ]
      })
    });

    const data = await groqRes.json();
    const answer = data.choices?.[0]?.message?.content || 'No answer generated.';

    // 3. Generate some default follow-up suggestions
    const followUps = [
      `Explain ${query} with more examples`,
      `Show me code for ${query}`,
      `What are the limitations of ${query}?`
    ];

    res.json({
      answerText: answer,
      followUps: followUps,
      sources: sources,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- IMAGE GENERATION (Pollinations) ----------
app.post('/generate-image', (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024`;
  res.json({ imageUrl: url });
});

// ---------- AVATAR GENERATION (Pollinations) ----------
app.post('/create-avatar', (req, res) => {
  const { style } = req.body;
  let prompt = 'anime avatar, cute character, studio ghibli style, profile picture';
  if (style && style.toLowerCase().includes('naruto')) {
    prompt = 'Naruto Uzumaki, anime style, orange jacket, spiky hair, headband';
  }
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512`;
  res.json({ imageUrl: url });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));