const FREE_TIER_LIMIT = 200_000_000; // Voyage-4-lite free tokens

export async function logTokenUsage(supabase, tokens) {
  try {
    const { data, error } = await supabase.rpc("increment_token_usage", { amount: tokens });
    if (error) {
      console.error("Usage log failed:", error.message);
      return;
    }
    const percentUsed = ((data / FREE_TIER_LIMIT) * 100).toFixed(2);
    if (data > FREE_TIER_LIMIT * 0.9) {
      console.warn(`⚠️ Voyage usage at ${percentUsed}% of free tier (${data} tokens)`);
    } else {
      console.log(`Voyage usage: ${percentUsed}% of free tier`);
    }
  } catch (e) {
    console.error("Usage logging error:", e);
  }
}

export async function getTokenUsage(supabase) {
  try {
    const { data, error } = await supabase
      .from("api_usage")
      .select("total_tokens")
      .eq("id", "voyage_embeddings")
      .single();

    if (error) return null;
    return {
      totalTokens: data.total_tokens,
      freeLimitTokens: FREE_TIER_LIMIT,
      percentUsed: ((data.total_tokens / FREE_TIER_LIMIT) * 100).toFixed(2),
    };
  } catch (e) {
    console.error("Error fetching usage:", e);
    return null;
  }
}