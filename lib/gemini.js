const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

const PROMPT_TEMPLATE = `You are a lead qualifier for a local lawn care business in Cookeville, TN.

Evaluate each of the following Facebook posts and determine if each is a genuine request for lawn mowing or yard care services.

Posts (JSON array):
{POSTS_JSON}

Each item has: postText, groupName.

Respond ONLY with a valid JSON array — one result object per post, in the same order. No markdown, no explanation:
[
  {
    "is_lead": true or false,
    "score": 1-10,
    "summary": "one sentence explaining why this is or isn't a lead",
    "urgency": "low" | "medium" | "high"
  }
]

Scoring guide:
- 8-10: Clear service request, residential, local, urgent
- 5-7: Likely request but vague or possibly commercial
- 1-4: Not a service request, or spam/joke/unrelated`;

// Strip markdown code fences that Gemini Flash-Lite occasionally adds
function stripFences(text) {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/g, '').trim();
}

// Score a batch of 3–5 posts in a single Gemini call.
// Returns an array of { is_lead, score, summary, urgency } in the same order.
export async function scorePostsBatch(apiKey, posts) {
  const postsJson = JSON.stringify(
    posts.map(p => ({ postText: p.postText, groupName: p.groupName }))
  );

  const prompt = PROMPT_TEMPLATE.replace('{POSTS_JSON}', postsJson);

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'text/plain' },
  };

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const cleaned = stripFences(rawText);

  let results;
  try {
    results = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (!Array.isArray(results)) {
    throw new Error(`Gemini response was not an array: ${cleaned.slice(0, 200)}`);
  }

  // Pad with nulls if Gemini returned fewer results than input (shouldn't happen, but guard it)
  while (results.length < posts.length) results.push(null);

  return results;
}
