import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// ────────────────────────────────────────────────
// クライアント初期化
// ────────────────────────────────────────────────
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ────────────────────────────────────────────────
// カテゴリ検出（既存ロジックを維持）
// ────────────────────────────────────────────────
function detectCategory(messages) {
  const firstUserMsg = messages.find(m => m.role === 'user')?.content?.toLowerCase() || '';
  const allText = messages.map(m => m.content).join(' ').toLowerCase();

  if (/三脚|tripod|さんきゃく|ビデオ三脚/.test(firstUserMsg)) return '三脚';
  if (/バッグ|bag|かばん|鞄|ケース|backpack|pouch|ウエスト/.test(firstUserMsg)) return 'バッグ';
  if (/雲台|ball head|fluid head|うんだい/.test(firstUserMsg)) return '雲台';
  if (/一脚|monopod|いっきゃく/.test(firstUserMsg)) return '一脚';
  if (/照明|ライト|lighting|スタンド/.test(firstUserMsg)) return 'ライティング';

  if (/三脚|tripod/.test(allText)) return '三脚';
  if (/バッグ|bag|backpack/.test(allText)) return 'バッグ';
  if (/一脚|monopod/.test(allText)) return '一脚';
  if (/雲台|ball head|fluid head/.test(allText)) return '雲台';
  if (/照明|ライト|lighting/.test(allText)) return 'ライティング';

  return null;
}

// ────────────────────────────────────────────────
// RAG検索：Supabaseから関連製品を取得
// ────────────────────────────────────────────────
async function searchProducts(query, category, maxPrice = null, limit = 6) {
  // クエリをEmbedding化
  const embeddingRes = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query
  });
  const embedding = embeddingRes.data[0].embedding;

  // Supabaseでベクトル検索
  const { data, error } = await supabase.rpc('search_products', {
    query_embedding: embedding,
    match_count: limit,
    filter_brand: null,
    filter_max_price: maxPrice
  });

  if (error) throw new Error(`Supabase error: ${error.message}`);

  // カテゴリでフィルター（categoryが指定されている場合）
  let results = data || [];
  if (category) {
    const filtered = results.filter(p =>
      p.category?.includes(category) || p.sub_category?.includes(category)
    );
    // フィルター後が少なすぎる場合は元の結果を使う
    results = filtered.length >= 2 ? filtered : results;
  }

  return results;
}

// ────────────────────────────────────────────────
// 質問フロー（既存を維持）
// ────────────────────────────────────────────────
const FLOWS = {
  ja: {
    '三脚': `【三脚の質問フロー】この順番で1つずつ質問：
1. 「三脚のみ」か「雲台セット」かを確認 → options:["三脚のみ","雲台セット"]
2. 用途を確認 → options:["写真メイン","動画メイン","両方"]
3. 使用機材を確認 → options:["Sony","Canon","Nikon","Fujifilm","その他"]
4. 素材を確認 → options:["カーボン","アルミ","こだわらない"]
5. 撮影シーンを確認 → options:["旅行・登山","街撮り","スタジオ","スポーツ"]`,

    'バッグ': `【カメラバッグの質問フロー】この順番で1つずつ質問：
1. バッグタイプを確認 → options:["バックパック","ショルダー","ウエスト","ローラー"]
2. 持ち出し機材を確認 → options:["1台+レンズ1〜2本","1台+レンズ3〜4本","2台以上"]
3. 最大レンズサイズを確認 → options:["標準ズーム","70-200mm","超望遠","シネレンズ"]
4. 個人荷物の量を確認 → options:["機材のみ","少し","普段使いも"]
5. 使用シーンを確認 → options:["旅行・登山","街撮り","プロ撮影","動画"]`,

    '雲台': `【雲台の質問フロー】この順番で1つずつ質問：
1. 雲台タイプを確認 → options:["ボールヘッド","フルードヘッド","3ウェイ","ギア","わからない"]
2. 用途を確認 → options:["写真メイン","動画メイン","両方"]
3. 機材重量を確認 → options:["〜2kg","2〜5kg","5〜10kg","10kg以上"]
4. 設置スピードを確認 → options:["素早い架設","精密な調整","こだわらない"]
5. 三脚との組み合わせを確認 → options:["Manfrotto三脚","他社三脚","これから購入"]`,

    '一脚': `【一脚の質問フロー】この順番で1つずつ質問：
1. 用途を確認 → options:["スポーツ・報道","動画・走り撮り","登山・旅行","野鳥・望遠"]
2. 機材重量を確認 → options:["〜1.5kg","〜2.5kg","〜5kg","〜8kg"]
3. 雲台の必要性を確認 → options:["一脚のみ","雲台セット","既に持っている"]
4. 自立機能を確認 → options:["必要","不要","あれば嬉しい"]
5. 素材を確認 → options:["カーボン","アルミ","こだわらない"]`,

    'ライティング': `【照明スタンドの質問フロー】この順番で1つずつ質問：
1. 用途を確認 → options:["ポートレート","動画・YouTube","商品撮影","屋外ロケ"]
2. 光源の種類を確認 → options:["ストロボ","LED","リングライト","大型モノブロック"]
3. スタンドの必要性を確認 → options:["スタンドも欲しい","既に持っている","アクセサリーのみ"]
4. 設置場所を確認 → options:["スタジオ固定","自宅・小スペース","屋外","卓上"]
5. アームの必要性を確認 → options:["必要","不要","わからない"]`
  },
  en: {
    '三脚': `[Tripod Flow] Ask ONE question at a time:
1. Tripod only or with head → options:["Tripod only","With head set"]
2. Main use → options:["Mainly photo","Mainly video","Both"]
3. Camera brand → options:["Sony","Canon","Nikon","Fujifilm","Other"]
4. Material → options:["Carbon","Aluminum","No preference"]
5. Scene → options:["Travel/hiking","Street","Studio","Sports"]`,

    'バッグ': `[Camera Bag Flow] Ask ONE question at a time:
1. Bag type → options:["Backpack","Shoulder bag","Waist bag","Roller bag"]
2. Gear → options:["1 body + 1-2 lenses","1 body + 3-4 lenses","2+ bodies"]
3. Largest lens → options:["Standard zoom","70-200mm","Super telephoto","Cine lens"]
4. Personal items → options:["Gear only","A little","Everyday use too"]
5. Scene → options:["Travel/hiking","Street","Professional","Video"]`,

    '雲台': `[Head Flow] Ask ONE question at a time:
1. Head type → options:["Ball head","Fluid head","3-way","Gear head","Not sure"]
2. Main use → options:["Mainly photo","Mainly video","Both"]
3. Equipment weight → options:["~2kg","2-5kg","5-10kg","10kg+"]
4. Setup speed → options:["Quick setup","Precise adjustment","No preference"]
5. Tripod combo → options:["Manfrotto tripod","Other brand","Not yet purchased"]`,

    '一脚': `[Monopod Flow] Ask ONE question at a time:
1. Main use → options:["Sports & news","Video & run","Hiking & travel","Wildlife & tele"]
2. Equipment weight → options:["~1.5kg","~2.5kg","~5kg","~8kg"]
3. Head needed → options:["Monopod only","With head","Already have one"]
4. Self-standing → options:["Yes needed","Not needed","Nice to have"]
5. Material → options:["Carbon","Aluminum","No preference"]`,

    'ライティング': `[Lighting Flow] Ask ONE question at a time:
1. Main use → options:["Portrait","Video & YouTube","Product","Outdoor"]
2. Light source → options:["Strobe","LED","Ring light","Large monoblock"]
3. Stand needed → options:["Need stand","Already have","Accessories only"]
4. Location → options:["Studio fixed","Home small space","Outdoor","Desktop"]
5. Boom arm → options:["Yes needed","Not needed","Not sure"]`
  }
};

// ────────────────────────────────────────────────
// システムプロンプト構築
// ────────────────────────────────────────────────
function buildGuidancePrompt(lang, category) {
  const flow = category && FLOWS[lang]?.[category]
    ? FLOWS[lang][category]
    : (lang === 'ja'
      ? 'まずどのカテゴリーをお探しか確認し、そのカテゴリーに合った質問をしてください。'
      : 'First confirm what product category they need, then follow the appropriate flow.');

  const langRule = lang === 'ja' ? '必ず日本語で回答してください。' : 'Always respond in English.';
  const exampleJa = `{"message":"動画撮影がメインですね！使用されるカメラを教えてください。","options":["Sony","Canon","Nikon","Fujifilm","その他"]}`;
  const exampleEn = `{"message":"Great, mainly for video! Which camera brand do you use?","options":["Sony","Canon","Nikon","Fujifilm","Other"]}`;

  return `You are a friendly Vitec Japan product advisor (Manfrotto, Gitzo, Lowepro, Avenger brands).
${langRule}

STYLE:
- Warmly acknowledge each answer before asking the next question
- Ask exactly ONE question per response

${flow}

Do NOT recommend products yet — keep gathering information.

RESPONSE FORMAT — output ONLY this JSON, nothing else:
{"message":"warm acknowledgment + one question","options":["opt1","opt2","opt3"]}

⚠️ MANDATORY RULES:
1. Output MUST be valid JSON only — no markdown, no extra text
2. "options" array MUST contain 3-5 items — NEVER empty
3. Each option must be short (under 12 characters)

Example: ${lang === 'ja' ? exampleJa : exampleEn}`;
}

function buildRecommendPrompt(lang, category, products) {
  const langRule = lang === 'ja' ? '必ず日本語で回答してください。' : 'Always respond in English.';

  const productList = products.map(p => ({
    name: p.name,
    sku: p.sku,
    brand: p.brand,
    category: p.category,
    price: p.price_sale,
    notes: p.notes,
    similarity: Math.round(p.similarity * 100) + '%'
  }));

  return `You are a Vitec Japan product advisor. Recommend products from the search results below.
${langRule}

SEARCH RESULTS (retrieved from database based on customer needs):
${JSON.stringify(productList, null, 2)}

INSTRUCTIONS:
- Recommend 3-5 products from the list above ONLY
- Never invent products not in the list
- Give specific reasons based on the customer's stated needs
- Include brand name in recommendations (Manfrotto / Gitzo / Lowepro / Avenger)
- If price is available, mention it

RESPONSE FORMAT — strict JSON only:
{"type":"products","message":"intro text","items":[{"name":"製品名","sku":"型番","brand":"ブランド","reason":"推薦理由2〜3文","price":数値orNull}]}

Recommend 3-5 products. Never return empty items array.`;
}

// ────────────────────────────────────────────────
// メインハンドラー
// ────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, lang = 'ja' } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  const category = detectCategory(messages);
  const userMessages = messages.filter(m => m.role === 'user');
  const lastUserMsg = userMessages[userMessages.length - 1]?.content || '';

  const recommendSignals = /以上です|おすすめして|推薦して|お願いします|please recommend|show me products|suggest products/i;
  const shouldRecommend = category &&
    userMessages.length >= 3 &&
    (userMessages.length >= 5 || recommendSignals.test(lastUserMsg));

  const phase = shouldRecommend ? 'RECOMMEND' : 'GUIDE';
  console.log(`[${phase}] lang:${lang} category:${category} turns:${userMessages.length}`);

  try {
    let systemPrompt;
    let ragProducts = [];

    if (shouldRecommend) {
      // RAG検索：会話全体をクエリとして使用
      const query = userMessages.map(m => m.content).join(' ');
      ragProducts = await searchProducts(query, category);
      systemPrompt = buildRecommendPrompt(lang, category, ragProducts);
    } else {
      systemPrompt = buildGuidancePrompt(lang, category);
    }

    // OpenAI GPT-4o で回答生成
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      temperature: 0.1,
      max_tokens: 1000
    });

    const raw = response.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    } catch {
      parsed = null;
    }

    if (!parsed && raw) {
      parsed = { message: raw.replace(/\*\*/g, ''), options: [] };
    }

    res.status(200).json({
      reply: parsed || { message: raw, options: [] },
      phase,
      category
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
