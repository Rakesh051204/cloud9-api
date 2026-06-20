import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import { tavily } from '@tavily/core';
import Groq from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTokenUsage } from './utils/usageTracker.js';
import { rerankResults } from './utils/embeddings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const textract = require('textract');
const Tesseract = require('tesseract.js');

dotenv.config();

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Bad JSON:', err.message);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

// ========== FILE UPLOAD SETUP ==========
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const fileStore = {};

async function extractTextFromFile(filePath, mimetype, originalname) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const ext = path.extname(originalname).toLowerCase();

    if (ext === '.pdf' || mimetype === 'application/pdf') {
      console.log('Processing PDF...');
      const data = await pdfParse(fileBuffer);
      return data.text || '';
    }

    if (ext === '.docx' || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return result.value || '';
    }

    if (ext === '.txt' || mimetype === 'text/plain') {
      return fileBuffer.toString('utf-8') || '';
    }

    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp'];
    if (imageExts.includes(ext) || imageTypes.includes(mimetype)) {
      console.log('Running OCR on image...');
      const result = await Tesseract.recognize(
        fileBuffer,
        'eng+fra+deu+spa+ita+por+rus+ara+hin+tam+tel+kan+mal+jpn+kor+chi_sim+chi_tra',
        { logger: (m) => {} }
      );
      return result.data.text || '';
    }

    console.log('Using textract for:', originalname);
    return new Promise((resolve) => {
      textract.fromFileWithPath(filePath, (err, text) => {
        if (err) {
          console.error('textract error:', err.message);
          resolve(null);
        } else {
          resolve(text || '');
        }
      });
    });
  } catch (e) {
    console.error('Extraction error:', e);
    return null;
  }
}

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const file = req.file;
    const text = await extractTextFromFile(file.path, file.mimetype, file.originalname);

    if (text === null || text === undefined) {
      fs.unlinkSync(file.path);
      return res.status(400).json({
        error: `Unsupported file type: "${file.originalname}". Please upload PDF, DOCX, TXT, images, or common office documents.`
      });
    }

    const key = userId || sessionId || 'anonymous';
    if (!fileStore[key]) fileStore[key] = [];

    const content = text.trim() || '[No extractable text – file may be empty or scanned]';

    fileStore[key].push({
      id: Date.now().toString(),
      filename: file.originalname,
      content: content,
      created: new Date().toISOString(),
    });

    fs.unlinkSync(file.path);

    res.json({
      success: true,
      message: `File "${file.originalname}" uploaded and processed.`,
      totalFiles: fileStore[key].length,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process file' });
  }
});

app.get('/files', (req, res) => {
  const { sessionId, userId } = req.query;
  const key = userId || sessionId || 'anonymous';
  const files = (fileStore[key] || []).map(f => ({
    id: f.id,
    filename: f.filename,
    created: f.created,
  }));
  res.json({ files });
});

app.delete('/files/:id', (req, res) => {
  const { sessionId, userId } = req.query;
  const key = userId || sessionId || 'anonymous';
  const fileId = req.params.id;
  if (fileStore[key]) {
    fileStore[key] = fileStore[key].filter(f => f.id !== fileId);
  }
  res.json({ success: true });
});

// ========== CLIENTS ==========
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ========== JWT HELPERS ==========
const generateToken = (user) => jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

// ========== OAUTH2 CLIENT ==========
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ========== CONVERSATION MEMORY ==========
const conversationMemory = new Map();

// ========== AUTH ENDPOINTS ==========
app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  const { data: userData, error: userError } = await supabase
    .from('users')
    .insert([{ id: data.user.id, email }])
    .select()
    .single();
  if (userError) return res.status(400).json({ error: userError.message });
  const token = generateToken(userData);
  res.json({ token, user: userData });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  const { data: userData } = await supabase.from('users').select('*').eq('id', data.user.id).single();
  const token = generateToken(userData);
  res.json({ token, user: userData });
});

app.get('/auth/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = verifyToken(token);
    const { data } = await supabase.from('users').select('*').eq('id', decoded.id).single();
    res.json({ user: data });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ========== GOOGLE OAUTH ==========
app.get('/auth/google', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    state: userId,
    prompt: 'consent',
  });
  res.json({ url });
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or state');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    const services = ['gmail', 'calendar', 'drive'];
    for (const service of services) {
      await supabase.from('connectors').upsert({
        user_id: userId,
        service,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        connected: true,
      }, { onConflict: 'user_id, service' });
    }
    res.redirect(`http://localhost:5173?oauth_success=true`);
  } catch (err) {
    console.error(err);
    res.status(500).send('OAuth failed');
  }
});

// ========== CONNECTOR STATUS ==========
app.get('/connectors/status', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = verifyToken(token);
    const { data, error } = await supabase
      .from('connectors')
      .select('service, connected')
      .eq('user_id', decoded.id);
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ========== GREETING DETECTION ==========
function detectGreeting(query) {
  const q = query.toLowerCase().trim();
  const greetings = [
    'hi', 'hello', 'hey', 'howdy', 'yo', 'sup', 'greetings',
    'hola', 'bonjour', 'hallo', 'ciao', 'namaste', 'नमस्ते',
    'வணக்கம்', 'నమస్కారం', 'ನಮಸ್ಕಾರ', 'നമസ്കാരം',
    'สวัสดี', 'こんにちは', '你好', '안녕하세요',
    'salut', 'cześć', 'привет', 'merhaba', 'salam',
    'aloha', 'geia', 'szia', 'hei', 'hej'
  ];
  if (greetings.includes(q)) return true;
  if (q.includes('bro') && q.split(' ').length <= 2) return true;
  if (q.includes('how are you') || q.includes('how are ya') || q.includes('how are u')) return true;
  return false;
}

function getGreetingResponse(query) {
  const q = query.toLowerCase().trim();
  if (q.includes('வணக்கம்')) return 'வணக்கம்! 👋 எப்படி உதவலாம்?';
  if (q.includes('नमस्ते')) return 'नमस्ते! 👋 मैं आपकी कैसे मदद कर सकता हूँ?';
  if (q.includes('hola')) return '¡Hola! 👋 ¿Cómo puedo ayudarte hoy?';
  if (q.includes('bonjour')) return 'Bonjour ! 👋 Comment puis-je vous aider aujourd\'hui ?';
  if (q.includes('hallo')) return 'Hallo! 👋 Wie kann ich dir heute helfen?';
  if (q.includes('ciao')) return 'Ciao! 👋 Come posso aiutarti oggi?';
  if (q.includes('こんにちは')) return 'こんにちは！ 👋 今日はどのようにお手伝いできますか？';
  if (q.includes('你好')) return '你好！ 👋 今天我能帮你什么？';
  if (q.includes('안녕하세요')) return '안녕하세요! 👋 오늘 어떻게 도와드릴까요?';
  if (q.includes('привет')) return 'Привет! 👋 Как я могу вам помочь сегодня?';
  if (q.includes('السلام عليكم')) return 'السلام عليكم! 👋 كيف يمكنني مساعدتك اليوم؟';
  if (q.includes('merhaba')) return 'Merhaba! 👋 Bugün sana nasıl yardımcı olabilirim?';
  if (q.includes('hej')) return 'Hej! 👋 Hur kan jag hjälpa dig idag?';
  if (q.includes('cześć')) return 'Cześć! 👋 Jak mogę ci dzisiaj pomóc?';
  if (q.includes('bro') && q.split(' ').length <= 2) return 'Hi bro! 🙌 What can I teach you or help you with today?';
  if (q.includes('how are you') || q.includes('how are ya') || q.includes('how are u')) {
    return "I'm doing great, thanks for asking! 😊 How can I help you?";
  }
  return 'Hello there! 👋 How can I assist you today?';
}

// ========== DETECT TRANSLATION REQUEST ==========
function detectTranslationRequest(query) {
  const q = query.toLowerCase();
  const patterns = [
    /translate to (\w+)/i,
    /answer in (\w+)/i,
    /in (\w+)/i,
    /(\w+) translation/i,
    /(\w+) la sollu/i,
  ];
  for (const p of patterns) {
    const match = q.match(p);
    if (match) return match[1];
  }
  const languages = ['tamil', 'hindi', 'telugu', 'kannada', 'malayalam', 'spanish', 'french', 'german', 'dutch', 'japanese', 'chinese', 'arabic'];
  for (const lang of languages) {
    if (q.includes(lang)) return lang;
  }
  return null;
}

// ========== PROMPT BUILDERS ==========
function buildFriendlyPrompt(query, data) {
  const { context, searchContext, fileContext } = data;

  const hasReadableText = fileContext && fileContext.trim().length > 10 && !/^[\s\W]+$/.test(fileContext);

  let prompt = `You are Stoic AI – a friendly assistant.

User question: ${query}

`;

  if (fileContext && fileContext.trim().length > 0) {
    if (hasReadableText) {
      prompt += `\n=== UPLOADED FILE CONTENT ===\n${fileContext}\n=== END OF FILE CONTENT ===\n\n`;
      prompt += `The user uploaded this file. Answer the question based ONLY on the content above.`;
    } else {
      prompt += `\n⚠️ The user uploaded a file, but the extracted text is unreadable or empty.
The file appears to be an image without visible text, a scanned document, or an empty file.
Please respond with: "I couldn't extract readable text from the file. Please try uploading a clearer image or a text-based document (PDF, DOCX, TXT)."
Do not suggest external tools.`;
    }
  } else {
    prompt += `\n(No file content available.)\n\n`;
  }

  if (searchContext && searchContext !== 'Web search unavailable.') {
    prompt += `\nWeb search results (for additional context):\n${searchContext}\n`;
  }

  if (context) {
    prompt += `\nUser's connected services data:\n${context}\n`;
  }

  prompt += `
Instructions:
1. If the file content is readable, use it as the primary source for your answer.
2. If the file content is unreadable, say so clearly and ask the user to upload a clearer file.
3. Do not mention external tools or services.
4. Answer in the same language as the user's question.`;

  return prompt;
}

function buildTranslationPrompt(originalQuery, originalAnswer, targetLanguage) {
  return `You previously answered the question: "${originalQuery}" with this answer:

${originalAnswer}

Now, please provide the SAME answer but translated into ${targetLanguage}. 
- Keep the same structure, citations, and tone.
- Only translate the text – do not change the content.
- Answer entirely in ${targetLanguage}.

Translated answer in ${targetLanguage}:`;
}

// ========== USAGE ROUTE ==========
app.get('/usage', async (req, res) => {
  const usage = await getTokenUsage(supabase);
  if (!usage) return res.status(500).json({ error: 'Failed to fetch usage' });
  res.json(usage);
});

// ========== MAIN AI AGENT /ask ==========
app.post('/ask', async (req, res) => {
  const { query, userId, searchEnabled = true, model = 'groq', sessionId } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const userKey = userId || sessionId || 'anonymous';
  const memory = conversationMemory.get(userKey) || {};

  // ----- GREETING -----
  if (detectGreeting(query)) {
    let greetingResponse = getGreetingResponse(query);
    greetingResponse = greetingResponse.charAt(0).toUpperCase() + greetingResponse.slice(1);
    return res.json({
      answer: greetingResponse,
      sources: [],
      relatedQuestions: ["What are you interested in learning?", "How can I help you today?", "Tell me what you're curious about!"],
      query,
      modelUsed: model,
    });
  }

  // ----- TRANSLATION REQUEST -----
  const targetLang = detectTranslationRequest(query);
  if (targetLang && memory.lastQuery && memory.lastAnswer) {
    const prompt = buildTranslationPrompt(memory.lastQuery, memory.lastAnswer, targetLang);
    let answer = '';
    try {
      answer = model === 'claude' ? await callClaude(prompt) : await callGroq(prompt);
    } catch (e) {
      console.error('Translation AI error:', e.message);
      answer = `I'm having trouble translating. Please try again later.`;
    }
    return res.json({
      answer,
      sources: [],
      relatedQuestions: [`Can you translate to another language?`, `Tell me more about ${memory.lastQuery}`],
      query,
      modelUsed: model,
    });
  }

  // ----- NORMAL FLOW -----
  try {
    let context = '';
    let connectorSources = [];

    if (userId) {
      try {
        const { data: connectors, error } = await supabase
          .from('connectors')
          .select('service, access_token, refresh_token, expiry_date')
          .eq('user_id', userId)
          .eq('connected', true);

        if (connectors && connectors.length > 0) {
          const result = await fetchConnectorData(connectors, userId);
          context = result.context || '';
          connectorSources = result.sources || [];
        }
      } catch (e) {
        console.error('Connector fetch error:', e.message);
      }
    }

    // ----- FILE CONTEXT -----
    let fileContext = '';
    const files = fileStore[userKey] || [];
    if (files.length > 0) {
      const allText = files.map(f => f.content).join('\n\n---\n\n');
      const maxChars = 5000;
      fileContext = allText.slice(0, maxChars);
      if (allText.length > maxChars) fileContext += '\n\n[Truncated...]';
    }

    // ----- WEB SEARCH (with advanced depth and raw content) -----
    let searchResults = [];
    let searchContext = '';
    if (searchEnabled && process.env.TAVILY_API_KEY) {
      try {
        const response = await tavilyClient.search(query, {
          searchDepth: 'advanced',
          maxResults: 6,
          includeRawContent: true,
        });
        searchResults = response.results || [];
        searchContext = searchResults.map((r, i) =>
          `[${i+1}] ${r.title}\n${r.content}\nSource: ${r.url}\n`
        ).join('\n');
      } catch (e) {
        console.error('Search error:', e.message);
        searchContext = 'Web search unavailable.';
      }
    }

    // ----- RERANK using Voyage embeddings -----
    if (searchResults.length > 0 && process.env.VOYAGE_API_KEY) {
      try {
        const reranked = await rerankResults(query, searchResults, supabase);
        searchResults = reranked;
        searchContext = searchResults.map((r, i) =>
          `[${i+1}] ${r.title}\n${r.content}\nSource: ${r.url}\n`
        ).join('\n');
        console.log(`Reranked ${searchResults.length} results`);
      } catch (e) {
        console.error('Reranking failed, using original order:', e.message);
      }
    }

    // ----- BUILD PROMPT -----
    const prompt = buildFriendlyPrompt(query, {
      context,
      searchContext,
      searchResults,
      fileContext,
    });

    // ----- CALL AI (with increased token budget) -----
    let answer = '';
    try {
      if (model === 'claude') {
        answer = await callClaude(prompt, 2048);
      } else {
        answer = await callGroq(prompt, 2048);
      }
    } catch (e) {
      console.error('AI call error:', e.message);
      answer = `I'm having trouble connecting. Please try again later.`;
    }

    conversationMemory.set(userKey, { lastQuery: query, lastAnswer: answer });

    const relatedQuestions = (answer && !answer.includes('API error'))
      ? await generateFollowUp(query, answer)
      : ["Can you rephrase?", "I'll help you better."];

    const sources = formatSources(searchResults, connectorSources);

    res.json({
      answer,
      sources,
      relatedQuestions,
      query,
      modelUsed: model,
    });

  } catch (error) {
    console.error('Unhandled error in /ask:', error);
    res.json({
      answer: `I encountered an error. Please try again.`,
      sources: [],
      relatedQuestions: ["What else would you like to know?", "Can I help with something else?"],
      query,
      modelUsed: model || 'groq',
    });
  }
});

// ========== HELPER FUNCTIONS ==========

async function fetchConnectorData(connectors, userId) {
  let context = '';
  let sources = [];

  for (const conn of connectors) {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    client.setCredentials({
      access_token: conn.access_token,
      refresh_token: conn.refresh_token,
      expiry_date: conn.expiry_date ? new Date(conn.expiry_date).getTime() : null,
    });

    if (conn.expiry_date && new Date(conn.expiry_date) < new Date()) {
      try {
        const { credentials } = await client.refreshAccessToken();
        await supabase.from('connectors')
          .update({ access_token: credentials.access_token, expiry_date: credentials.expiry_date ? new Date(credentials.expiry_date) : null })
          .eq('user_id', userId)
          .eq('service', conn.service);
        client.setCredentials(credentials);
      } catch (e) {
        continue;
      }
    }

    try {
      if (conn.service === 'gmail') {
        const gmail = google.gmail({ version: 'v1', auth: client });
        const messages = await gmail.users.messages.list({ userId: 'me', maxResults: 3 });
        const summaries = [];
        for (const msg of messages.data.messages || []) {
          const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From'] });
          const headers = detail.data.payload?.headers || [];
          const subject = headers.find(h => h.name === 'Subject')?.value || 'No subject';
          const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
          summaries.push(`From: ${from} | Subject: ${subject}`);
        }
        context += `\nRecent emails:\n${summaries.join('\n')}`;
        sources.push({ service: 'gmail', count: summaries.length });
      } else if (conn.service === 'calendar') {
        const calendar = google.calendar({ version: 'v3', auth: client });
        const events = await calendar.events.list({ calendarId: 'primary', maxResults: 3, singleEvents: true, orderBy: 'startTime' });
        const list = events.data.items || [];
        const summaries = list.map(e => `${e.summary || 'No title'} (${e.start?.dateTime || e.start?.date})`);
        context += `\nUpcoming events:\n${summaries.join('\n')}`;
        sources.push({ service: 'calendar', count: list.length });
      } else if (conn.service === 'drive') {
        const drive = google.drive({ version: 'v3', auth: client });
        const files = await drive.files.list({ pageSize: 3, fields: 'files(name, webViewLink)' });
        const list = files.data.files || [];
        const summaries = list.map(f => `${f.name} (${f.webViewLink})`);
        context += `\nRecent files:\n${summaries.join('\n')}`;
        sources.push({ service: 'drive', count: list.length });
      }
    } catch (e) {
      console.error('Error fetching', conn.service, e.message);
    }
  }

  return { context, sources };
}

async function callGroq(prompt, maxTokens = 1024) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: maxTokens,
    });
    return response.choices[0].message.content;
  } catch (e) {
    console.error('Groq error:', e);
    throw new Error('Groq API call failed: ' + e.message);
  }
}

async function callClaude(prompt, maxTokens = 1024) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: maxTokens,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0].text;
  } catch (e) {
    console.error('Claude error:', e);
    throw new Error('Claude API call failed: ' + e.message);
  }
}

async function generateFollowUp(query, answer) {
  return [
    `Can you tell me more about ${query}?`,
    `What are the key takeaways?`,
    `How can I apply this?`,
    `Any common misconceptions?`,
  ];
}

function formatSources(searchResults, connectorSources) {
  const sources = [];
  searchResults.forEach((r, i) => {
    sources.push({
      title: r.title || `Source ${i+1}`,
      url: r.url,
      type: 'web',
    });
  });
  connectorSources.forEach(s => {
    sources.push({
      title: `${s.service} data`,
      url: '#',
      type: s.service,
    });
  });
  return sources;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));