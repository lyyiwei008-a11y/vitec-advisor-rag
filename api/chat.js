import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ────────────────────────────────────────────────
// カテゴリ検出
// フロントから brand / category が渡される場合はそちらを優先
// ────────────────────────────────────────────────
function detectCategory(messages, categoryHint) {
  if (categoryHint) return categoryHint;

  const allText = messages.map(m => m.content).join(' ').toLowerCase();
  if (/三脚|tripod|さんきゃく|ビデオ三脚|photo tripod|video tripod/.test(allText)) return '三脚';
  if (/バッグ|bag|かばん|鞄|ケース|backpack|pouch|ショルダー|shoulder/.test(allText)) return 'バッグ';
  if (/雲台|ball head|fluid head|うんだい|head/.test(allText)) return '雲台';
  if (/一脚|monopod|いっきゃく/.test(allText)) return '一脚';
  if (/照明|ライト|lighting|スタンド|stand/.test(allText)) return 'ライティング';
  return null;
}

// ────────────────────────────────────────────────
// RAG検索
// ────────────────────────────────────────────────
async function searchProducts(query, brandFilter = null, categoryFilter = null, limit = 10) {
  const embeddingRes = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query
  });
  const embedding = embeddingRes.data[0].embedding;

  const { data, error } = await supabase.rpc('match_products', {
    query_embedding: embedding,
    match_count: limit,
    filter_brand: brandFilter,
    include_old: false
  });

  if (error) throw new Error(`Supabase error: ${error.message}`);
  let results = data || [];

  // カテゴリでフィルター（シート名が一致するもの優先）
  if (categoryFilter) {
    const filtered = results.filter(p => p.category === categoryFilter);
    // フィルター結果が3件以上あればそれを使用、少なければ元の結果を使用
    if (filtered.length >= 3) results = filtered;
  }

  // priority=1（新製品）を上位に並び替え
  results.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.similarity - a.similarity;
  });

  return results.slice(0, 8);
}

// ────────────────────────────────────────────────
// 質問フロー定義
// ────────────────────────────────────────────────
const FLOWS = {
  ja: {
    // Manfrotto
    'フォト三脚': `【フォト三脚の質問フロー】1つずつ質問：
1. 三脚のみかセットか確認 → options:["三脚のみ","雲台セット"]
2. 素材 → options:["カーボン","アルミ","こだわらない"]
3. 使用カメラ → options:["Sony","Canon","Nikon","Fujifilm","その他"]
4. 撮影シーン → options:["旅行・登山","街撮り","スタジオ","スポーツ"]
5. 予算感 → options:["〜3万円","3〜8万円","8万円以上"]`,

    'ビデオ三脚': `【ビデオ三脚の質問フロー】1つずつ質問：
1. 三脚のみかセットか → options:["三脚のみ","雲台セット"]
2. 機材の重さ → options:["〜5kg","5〜10kg","10kg以上"]
3. 使用シーン → options:["YouTube・Vlog","放送・報道","シネマ","スタジオ"]
4. ツインレッグかシングルか → options:["ツインレッグ","シングルレッグ","わからない"]
5. 素材 → options:["カーボン","アルミ","こだわらない"]`,

    'フォト雲台': `【フォト雲台の質問フロー】1つずつ質問：
1. 雲台タイプ → options:["ボールヘッド","3ウェイ","ギア","わからない"]
2. 機材重量 → options:["〜2kg","2〜5kg","5〜10kg"]
3. クイックリリース → options:["必要","なくてもよい","わからない"]
4. 三脚との組み合わせ → options:["Manfrotto三脚","他社三脚","これから購入"]
5. 予算感 → options:["〜2万円","2〜5万円","5万円以上"]`,

    'ビデオ雲台': `【ビデオ雲台の質問フロー】1つずつ質問：
1. 耐荷重の目安 → options:["〜4kg","4〜8kg","8〜12kg","12kg以上"]
2. ボウルサイズ → options:["フラットベース","60mm","75mm","100mm","わからない"]
3. カウンターバランス → options:["固定でよい","無段階調整したい","わからない"]
4. 三脚との組み合わせ → options:["Manfrotto三脚","他社三脚","これから購入"]
5. キットか単体か → options:["雲台のみ","三脚セットで欲しい"]`,

    '一脚': `【一脚の質問フロー】1つずつ質問：
1. 用途 → options:["スポーツ・報道","動画・走り撮り","登山・旅行","野鳥・望遠"]
2. 機材重量 → options:["〜1.5kg","〜2.5kg","〜5kg","〜8kg"]
3. 雲台 → options:["一脚のみ","雲台セット","既に持っている"]
4. 素材 → options:["カーボン","アルミ","こだわらない"]`,

    'カメラバッグ': `【カメラバッグの質問フロー】1つずつ質問：
1. バッグタイプ → options:["バックパック","ショルダー","TLZトップローディング","ローラー"]
2. 収納機材 → options:["1台+レンズ1〜2本","1台+レンズ3〜4本","2台以上"]
3. 最大レンズサイズ → options:["標準ズーム","70-200mm","超望遠","シネレンズ"]
4. 個人荷物 → options:["機材のみ","少し","普段使いも"]
5. 使用シーン → options:["旅行・登山","街撮り","プロ撮影","動画"]`,

    'ライティング': `【ライティングの質問フロー】1つずつ質問：
1. 用途 → options:["ポートレート","動画・YouTube","商品撮影","屋外ロケ"]
2. 光源の種類 → options:["ストロボ","LED","リングライト","大型モノブロック"]
3. スタンド → options:["スタンドも欲しい","既に持っている","アクセサリーのみ"]
4. 設置場所 → options:["スタジオ固定","自宅・小スペース","屋外","卓上"]
5. アーム → options:["必要","不要","わからない"]`,

    'アクセサリー': `【アクセサリーの質問フロー】1つずつ質問：
1. 何に使いたいか → options:["カメラ固定・支持","テザー撮影","ライティング補助","その他"]
2. 取り付け先 → options:["三脚","ライトスタンド","カメラ本体","壁・天井"]
3. 具体的に欲しいもの → options:["マジックアーム","クランプ","プレート","ストラップ"]`,

    // Gitzo
    '三脚':  `【Gitzo三脚の質問フロー】1つずつ質問：
1. 三脚ファミリー → options:["トラベラー","マウンテニア","システマティック","わからない"]
2. 段数 → options:["3段","4段","5段","こだわらない"]
3. 機材重量 → options:["〜3kg","3〜6kg","6〜10kg","10kg以上"]
4. 素材 → options:["カーボン","アルミ","こだわらない"]
5. センターポール → options:["必要","なくてもよい","わからない"]`,

    'Gitzo一脚': `【Gitzo一脚の質問フロー】1つずつ質問：
1. 用途 → options:["風景・旅行","スポーツ・望遠","動画"]
2. 機材重量 → options:["〜3kg","3〜6kg","6kg以上"]
3. 段数 → options:["4段","5段","6段","こだわらない"]`,

    '雲台': `【Gitzo雲台の質問フロー】1つずつ質問：
1. 雲台タイプ → options:["センターボール","フルード","パノラマ","わからない"]
2. 機材重量 → options:["〜5kg","5〜10kg","10〜25kg"]
3. 三脚との組み合わせ → options:["Gitzo三脚","他社三脚","これから購入"]`,

    'バッグ・アクセサリー': `【Gitzoバッグの質問フロー】1つずつ質問：
1. 何を収納したいか → options:["三脚バッグ","カメラバッグ","アクセサリー"]
2. 対応三脚サイズ → options:["トラベラー","マウンテニア","大型システマティック"]`,

    // Lowepro
    'バックパック': `【Loweproバックパックの質問フロー】1つずつ質問：
1. シリーズ感 → options:["プロタクティック","フリップサイド","プロトレッカー","べーシック"]
2. 収納機材 → options:["ミラーレス+レンズ2〜3本","一眼+レンズ3〜4本","大型機材+アクセサリー"]
3. PC収納 → options:["13インチ以下","15インチ","不要"]
4. 使用シーン → options:["旅行・登山","街撮り","プロ撮影","ドローン運搬"]
5. レインカバー → options:["必要","あれば嬉しい","不要"]`,

    'ショルダーバッグ': `【Loweproショルダーの質問フロー】1つずつ質問：
1. 機材の量 → options:["カメラ1台+レンズ1本","カメラ1台+レンズ複数","コンパクトのみ"]
2. バッグスタイル → options:["斜めがけ","スリング","トップローディング"]
3. 使用シーン → options:["日常・街撮り","旅行","スポーツ・アウトドア"]`,

    'TLZ・トップローディング': `【Lowepro TLZの質問フロー】1つずつ質問：
1. 収納したいレンズ → options:["〜24-70mm","〜70-200mm","300mm以上"]
2. 取り出しやすさ → options:["素早く取り出したい","しっかり保護したい","両方"]
3. 別バッグに入れる → options:["単独で使う","他のバッグのインサートとして"]`,

    'レンズ・ハードケース': `【Loweproケースの質問フロー】1つずつ質問：
1. 何を収納したいか → options:["交換レンズ","カメラ+アクセサリー","バッテリー・小物"]
2. 収納するレンズサイズ → options:["〜8cm径","〜11cm径","〜13cm径"]
3. 使い方 → options:["バッグのインサート","単独で携帯","スタジオ保管"]`,

    'ギアアップ・アクセサリー': `【Loweproギアアップの質問フロー】1つずつ質問：
1. 何を収納したいか → options:["ケーブル・バッテリー","カメラ本体","レンズ","メモリーカード"]
2. 使い方 → options:["バッグのインサート","単独で使う","整理収納"]`
  },

  en: {
    'Photo Tripod': `[Photo Tripod Flow] Ask ONE at a time:
1. Tripod only or with head → options:["Tripod only","With head set"]
2. Material → options:["Carbon","Aluminum","No preference"]
3. Camera brand → options:["Sony","Canon","Nikon","Fujifilm","Other"]
4. Scene → options:["Travel/hiking","Street","Studio","Sports"]`,

    'Backpack': `[Lowepro Backpack Flow] Ask ONE at a time:
1. Series → options:["ProTactic","FlipSide","Pro Trekker","Basic"]
2. Gear → options:["Mirrorless+2-3 lenses","DSLR+3-4 lenses","Large gear+accessories"]
3. Laptop → options:["Up to 13\"","15\"","Not needed"]
4. Scene → options:["Travel/hiking","Street","Professional","Drone"]`,

    'Tripod': `[Gitzo Tripod Flow] Ask ONE at a time:
1. Family → options:["Traveler","Mountaineer","Systematic","Not sure"]
2. Sections → options:["3 sections","4 sections","5 sections","No preference"]
3. Payload → options:["Up to 3kg","3-6kg","6-10kg","10kg+"]`
  }
};

// ────────────────────────────────────────────────
// システムプロンプト構築
// ────────────────────────────────────────────────
function buildGuidancePrompt(lang, category, brand) {
  // カテゴリ名の正規化（英語→日本語フローへのマッピング）
  const catMap = {
    'Photo Tripod': 'フォト三脚', 'Video Tripod': 'ビデオ三脚',
    'Photo Head': 'フォト雲台', 'Video Head': 'ビデオ雲台',
    'Monopod': '一脚', 'Camera Bag': 'カメラバッグ',
    'Lighting': 'ライティング', 'Accessories': 'アクセサリー',
    'Tripod': '三脚', 'Head': '雲台',
    'Bag & Accessories': 'バッグ・アクセサリー',
    'Backpack': 'バックパック', 'Shoulder Bag': 'ショルダーバッグ',
    'TLZ / Top Loading': 'TLZ・トップローディング',
    'Lens & Hard Case': 'レンズ・ハードケース',
    'GearUp & Accessories': 'ギアアップ・アクセサリー'
  };

  const flowKey = catMap[category] || category;
  const flow = FLOWS[lang]?.[flowKey] || FLOWS['ja']?.[flowKey]
    || (lang === 'ja'
      ? `まず${brand ? brand + 'の' : ''}どのような製品をお探しか確認し、用途・機材・予算などを1つずつ質問してください。`
      : `Ask about what kind of ${brand || 'Vitec'} product they need, then gather details one by one.`);

  const langRule = lang === 'ja' ? '必ず日本語で回答してください。' : 'Always respond in English.';
  const brandRule = brand ? `対象ブランド: ${brand}のみ。他ブランドは言及しないこと。` : '対象: Manfrotto / Gitzo / Lowepro / Avenger 全ブランド。';

  return `You are a friendly Vitec Japan product advisor.
${langRule}
${brandRule}

STYLE:
- Warmly acknowledge each answer before asking the next question
- Ask exactly ONE question per response
- Never recommend specific products yet — keep gathering information

${flow}

RESPONSE FORMAT — output ONLY this JSON, nothing else:
{"message":"warm acknowledgment + one question","options":["opt1","opt2","opt3"]}

⚠️ RULES:
1. Output MUST be valid JSON only — no markdown, no extra text
2. "options" MUST contain 2-5 items — NEVER empty
3. Each option must be short (under 15 characters)`;
}

function buildRecommendPrompt(lang, brand, products) {
  const langRule = lang === 'ja' ? '必ず日本語で回答してください。' : 'Always respond in English.';
  const brandRule = brand ? `対象ブランド: ${brand}` : '対象: 全ブランド (Manfrotto / Gitzo / Lowepro / Avenger)';

  const productList = products.map(p => ({
    name:       p.name,
    sku:        p.sku,
    brand:      p.brand,
    category:   p.category,
    priority:   p.priority,
    content:    p.content,
    similarity: Math.round(p.similarity * 100) + '%'
  }));

  return `You are a Vitec Japan product advisor. Recommend products from the search results below.
${langRule}
${brandRule}

SEARCH RESULTS (priority 1=new, 2=current — already filtered):
${JSON.stringify(productList, null, 2)}

INSTRUCTIONS:
- Recommend 3-5 products from the list ONLY
- Never invent products not in the list
- Give specific reasons based on the customer's stated needs
- Mention brand name in each recommendation
- Extract price from content field if available (look for "販売価格: ¥" or "メーカ希望小売価格: ¥")
- Priority 1 products are new/featured — highlight them if relevant

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

  const { messages, lang = 'ja', brand = null, category = null } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  const detectedCategory = detectCategory(messages, category);
  const userMessages = messages.filter(m => m.role === 'user');
  const lastUserMsg  = userMessages[userMessages.length - 1]?.content || '';

  // レコメンド判定：3回以上の会話 or 明示的なシグナル
  const recommendSignals = /以上です|おすすめして|推薦して|お願いします|please recommend|show me|suggest/i;
  const shouldRecommend  = userMessages.length >= 3 &&
    (userMessages.length >= 5 || recommendSignals.test(lastUserMsg));

  const phase = shouldRecommend ? 'RECOMMEND' : 'GUIDE';
  console.log(`[${phase}] lang:${lang} brand:${brand} category:${detectedCategory} turns:${userMessages.length}`);

  try {
    let systemPrompt;
    let ragProducts = [];

    if (shouldRecommend) {
      // カテゴリをクエリに含めてRAG検索精度を上げる
      const categoryQuery = detectedCategory ? detectedCategory + ' ' : '';
      const brandQuery = brand ? brand + ' ' : '';
      const userQuery = userMessages.map(m => m.content).join(' ');
      const query = brandQuery + categoryQuery + userQuery;

      // カテゴリ→シートマッピング（Supabaseのcategory列でフィルター）
      const categorySheetMap = {
        'フォト三脚': '01_フォト三脚', 'ビデオ三脚': '08_ビデオ三脚',
        'フォト雲台': '02_フォト雲台', 'ビデオ雲台': '07_ビデオ雲台',
        '一脚': '03_フォト一脚', 'カメラバッグ': '10_カメラバッグ',
        'ライティング': '11_ライティング', 'アクセサリー': '04_三脚雲台Acc',
        '三脚': null, '雲台': null,
        'バックパック': 'バックパック', 'ショルダーバッグ': 'ショルダー・TLZ・スリング',
        'TLZ・トップローディング': 'ショルダー・TLZ・スリング',
        'レンズ・ハードケース': 'レンズ・ハードサイドケース',
        'ギアアップ・アクセサリー': 'ギアアップ GearUp',
      };
      const categoryFilter = categorySheetMap[detectedCategory];
      ragProducts = await searchProducts(query, brand, categoryFilter);
      systemPrompt = buildRecommendPrompt(lang, brand, ragProducts);
    } else {
      systemPrompt = buildGuidancePrompt(lang, detectedCategory, brand);
    }

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
    console.log('[RAW RESPONSE]', raw.substring(0, 500));

    let parsed = null;

    // 1. まずJSONとして厳密にパース
    try {
      const clean = raw.replace(/```json\n?|```/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      }
    } catch(e) {
      console.log('[PARSE ERROR]', e.message);
    }

    // 2. パース失敗時: フォールバック（テキストからoptionsを抽出）
    if (!parsed) {
      // options配列をテキストから正規表現で抽出試行
      const optMatch = raw.match(/"options"\s*:\s*(\[[^\]]+\])/);
      const msgMatch = raw.match(/"message"\s*:\s*"([^"]+)"/);
      if (msgMatch) {
        parsed = {
          message: msgMatch[1],
          options: optMatch ? JSON.parse(optMatch[1]) : []
        };
      } else {
        parsed = { message: raw.replace(/\*\*/g, '').trim(), options: [] };
      }
    }

    // 3. optionsが空またはない場合、カテゴリに応じたデフォルト選択肢を付与
    if (parsed && (!parsed.options || parsed.options.length === 0) && phase === 'GUIDE') {
      const defaultOptions = {
        'フォト三脚':   ['カーボン', 'アルミ', 'こだわらない'],
        'ビデオ三脚':   ['〜5kg', '5〜10kg', '10kg以上'],
        'フォト雲台':   ['ボールヘッド', '3ウェイ', 'ギア'],
        'ビデオ雲台':   ['〜4kg', '4〜8kg', '12kg以上'],
        '一脚':         ['スポーツ', '旅行・登山', '動画'],
        'カメラバッグ': ['バックパック', 'ショルダー', 'TLZ'],
        '三脚':         ['カーボン', 'アルミ', 'こだわらない'],
        'バックパック': ['プロタクティック', 'フリップサイド', 'ベーシック'],
      };
      parsed.options = defaultOptions[detectedCategory] || ['はい', 'いいえ', 'わからない'];
    }

    console.log('[PARSED]', JSON.stringify(parsed).substring(0, 300));

    res.status(200).json({
      reply: parsed,
      phase,
      category: detectedCategory,
      brand
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
