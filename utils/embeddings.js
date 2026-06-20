import { logTokenUsage } from "./usageTracker.js";

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

export async function getEmbeddings(texts, inputType = "document", supabase = null) {
  const input = Array.isArray(texts) ? texts : [texts];

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input,
      model: "voyage-4-lite",
      input_type: inputType,
      output_dimension: 1024,
    }),
  });

  const data = await response.json();

  if (data.usage?.total_tokens && supabase) {
    logTokenUsage(supabase, data.usage.total_tokens);
  }

  if (!data.data || !Array.isArray(data.data)) {
    console.error("Voyage response error:", data);
    throw new Error("Invalid embedding response");
  }

  return data.data.map((d) => d.embedding);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function getEmbeddingWithCache(text, url, supabase) {
  // Check if we already have this embedding in the DB
  const { data, error } = await supabase
    .from('search_embeddings')
    .select('embedding')
    .eq('source_url', url)
    .maybeSingle();

  if (data && data.embedding) {
    console.log(`✅ Using cached embedding for: ${url}`);
    return data.embedding;
  }

  // Not cached – get from Voyage
  const [embedding] = await getEmbeddings(text, 'document', supabase);

  // Store in DB
  await supabase
    .from('search_embeddings')
    .insert({
      source_url: url,
      content: text.slice(0, 1000), // Store first 1000 chars
      embedding: embedding,
    });

  console.log(`💾 Cached embedding for: ${url}`);
  return embedding;
}

export async function rerankResults(query, results, supabase = null) {
  if (!results || results.length === 0) return results;
  const contents = results.map((r) => r.content || r.snippet || "").filter(Boolean);
  if (contents.length === 0) return results;

  try {
    const [queryEmbedding] = await getEmbeddings(query, "query", supabase);

    const docEmbeddings = [];
    for (const r of results) {
      const text = r.content || r.snippet || "";
      if (!text) {
        docEmbeddings.push(queryEmbedding);
        continue;
      }
      const emb = await getEmbeddingWithCache(text, r.url, supabase);
      docEmbeddings.push(emb);
    }

    return results
      .map((r, i) => ({
        ...r,
        score: cosineSimilarity(queryEmbedding, docEmbeddings[i] || queryEmbedding),
      }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  } catch (err) {
    console.error("Reranking failed, returning original order:", err.message);
    return results;
  }
}