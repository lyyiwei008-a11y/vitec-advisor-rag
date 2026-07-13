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

  // 通常検索
  const { data, error } = await supabase.rpc('match_products', {
    query_embedding: embedding,
    match_count: limit,
    filter_brand: brandFilter,
    include_old: false
  });
  if (error) throw new Error(`Supabase error: ${error.message}`);
  let results = data || [];

  // カテゴリでフィルター
  if (categoryFilter) {
    const filters = Array.isArray(categoryFilter) ? categoryFilter : [categoryFilter];
    const filtered = results.filter(p => filters.includes(p.category));
    if (filtered.length >= 3) results = filtered;
  }

  // priority=1（新製品）を別途取得して必ず含める
  const { data: newData } = await supabase
    .from('products')
    .select('id, sku, name, brand, category, priority, content')
    .eq('priority', 1)
    .eq(brandFilter ? 'brand' : 'priority', brandFilter || 1)
    .limit(5);

  if (newData && newData.length > 0) {
    // 新製品にsimilarity=1.0を付与して先頭に追加（重複除去）
    const existingIds = new Set(results.map(r => r.id));
    const newProducts = newData
      .filter(p => !existingIds.has(p.id))
      .map(p => ({ ...p, similarity: 1.0 }));
    results = [...newProducts, ...results];
  }

  // priority順→similarity順でソート
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
    // ── Manfrotto ──
    '三脚': `【三脚の質問フロー】1つずつ質問：
1. 主な用途 → options:["写真撮影メイン","動画撮影メイン","写真・動画両方"]
2. 使用機材の重さ（カメラ＋レンズ合計） → options:["〜2kg","2〜5kg","5〜10kg","10kg以上"]
3. 撮影シーン → options:["旅行・登山","街撮り・日常","スタジオ・室内","スポーツ・野鳥","放送・シネマ"]
4. 素材のこだわり → options:["カーボン（軽量優先）","アルミ（コスパ優先）","こだわらない"]
5. 予算感 → options:["〜3万円","3〜8万円","8〜15万円","15万円以上"]`,

    '雲台': `【雲台の質問フロー】1つずつ質問：
1. 主な用途 → options:["写真撮影メイン","動画撮影メイン","写真・動画両方"]
2. 写真メインの場合: 雲台タイプ → options:["ボールヘッド","3ウェイ","ギア雲台","わからない"]
   動画メインの場合: 耐荷重の目安 → options:["〜4kg","4〜8kg","8〜12kg","12kg以上"]
3. 使用機材の重さ → options:["〜2kg","2〜5kg","5〜10kg","10kg以上"]
4. 三脚との組み合わせ → options:["Manfrotto三脚と合わせたい","他社三脚を持っている","三脚もこれから購入"]
5. 予算感 → options:["〜2万円","2〜5万円","5〜10万円","10万円以上"]`,

    '一脚': `【一脚の質問フロー】1つずつ質問：
1. 主な用途 → options:["スポーツ・報道","動画・Vlog","登山・旅行","野鳥・超望遠"]
2. 機材の重さ → options:["〜1.5kg","〜2.5kg","〜5kg","5kg以上"]
3. 雲台は必要か → options:["一脚のみでよい","雲台セットが欲しい","既に雲台を持っている"]
4. 素材 → options:["カーボン（軽量優先）","アルミ（コスパ優先）","こだわらない"]`,

    'カメラバッグ': `【カメラバッグの質問フロー】1つずつ質問：
1. バッグのスタイル → options:["バックパック","ショルダーバッグ","トップローディング","どれでもよい"]
2. 収納したい機材 → options:["ミラーレス1台+レンズ1〜2本","一眼+レンズ3〜4本","大型機材複数","動画機材一式"]
3. 最大レンズサイズ → options:["標準ズーム程度","70-200mm","超望遠300mm以上","シネレンズ"]
4. PC・タブレット収納 → options:["13インチ以下","15インチ","不要"]
5. 使用シーン → options:["旅行・登山","街撮り・日常","プロ撮影","ドローン運搬"]`,

    'ライティング': `【ライティングの質問フロー】1つずつ質問：
1. 主な用途 → options:["ポートレート","動画・YouTube","商品・物撮り","屋外ロケ"]
2. 光源の種類 → options:["ストロボ","LED","リングライト","大型モノブロック"]
3. スタンドも必要か → options:["スタンドも欲しい","既に持っている","アクセサリーのみ"]
4. 設置場所 → options:["スタジオ固定","自宅・小スペース","屋外移動","卓上"]
5. アームも必要か → options:["必要","不要","わからない"]`,

    'アクセサリー': `【アクセサリーの質問フロー】1つずつ質問：
1. 何に使いたいか → options:["カメラ固定・支持","テザー撮影","ライティング補助","その他"]
2. 取り付け先 → options:["三脚","ライトスタンド","カメラ本体","壁・天井"]
3. 具体的に欲しいもの → options:["マジックアーム","クランプ","プレート","ストラップ"]`,

    // ── Gitzo ──
    '三脚（Gitzo）': `【Gitzo三脚の質問フロー】1つずつ質問：
1. 撮影シーン → options:["旅行・登山・バックパック","風景・長時間露光","野鳥・超望遠","動画・映像制作","スタジオ"]
2. カメラ＋レンズの合計重量 → options:["〜3kg","3〜6kg","6〜10kg","10kg以上"]
3. 雲台も必要か → options:["三脚のみ","雲台もセットで欲しい","既に雲台を持っている"]
4. 携帯性のこだわり → options:["できるだけ軽く小さく","多少重くても安定性重視","バランス重視"]
5. 予算感 → options:["〜5万円","5〜10万円","10〜20万円","20万円以上"]`,

    '一脚（Gitzo）': `【Gitzo一脚の質問フロー】1つずつ質問：
1. 撮影シーン → options:["スポーツ・野鳥","風景・旅行","動画・Vlog"]
2. 機材の重さ → options:["〜3kg","3〜6kg","6kg以上"]
3. 段数のこだわり → options:["コンパクトに畳みたい（多段）","剛性重視（少段）","こだわらない"]`,

    '雲台（Gitzo）': `【Gitzo雲台の質問フロー】1つずつ質問：
1. 主な用途 → options:["写真撮影","動画撮影","パノラマ・360°"]
2. 機材の重さ → options:["〜5kg","5〜10kg","10〜25kg"]
3. 三脚との組み合わせ → options:["Gitzo三脚と合わせたい","他社三脚を持っている","三脚もこれから購入"]`,

    'バッグ・アクセサリー（Gitzo）': `【Gitzoバッグの質問フロー】1つずつ質問：
1. 何を収納したいか → options:["三脚バッグ","カメラバッグ","アクセサリー"]
2. 対応したい三脚サイズ → options:["コンパクト（トラベラー相当）","中型","大型（システマティック相当）"]`,

    // ── Lowepro ──
    'バックパック': `【Loweproバックパックの質問フロー】1つずつ質問：
1. 収納したい機材 → options:["ミラーレス+レンズ2〜3本","一眼+レンズ3〜4本","大型機材+アクセサリー一式"]
2. 最大レンズサイズ → options:["標準ズーム程度","70-200mm","超望遠・シネレンズ"]
3. PC・タブレット収納 → options:["13インチ以下","15インチ","不要"]
4. 使用シーン → options:["旅行・登山","街撮り・日常","プロ撮影","ドローン運搬"]
5. 防水・レインカバー → options:["必須","あれば嬉しい","不要"]`,

    'ショルダーバッグ': `【Loweproショルダーの質問フロー】1つずつ質問：
1. 収納したい機材 → options:["コンパクト1台のみ","カメラ1台+レンズ1本","カメラ1台+レンズ複数"]
2. バッグのスタイル → options:["斜めがけショルダー","スリング","トップローディング"]
3. 使用シーン → options:["日常・街撮り","旅行","スポーツ・アウトドア"]`,

    'TLZ・トップローディング': `【Lowepro TLZの質問フロー】1つずつ質問：
1. 収納したいレンズサイズ → options:["〜24-70mm","〜70-200mm","300mm以上"]
2. 重視すること → options:["素早く取り出したい","しっかり保護したい","両方"]
3. 使い方 → options:["単独で使う","他のバッグのインサートとして"]`,

    'レンズ・ハードケース': `【Loweproケースの質問フロー】1つずつ質問：
1. 収納したいもの → options:["交換レンズ","カメラ本体+アクセサリー","バッテリー・小物"]
2. レンズサイズ → options:["小型（〜8cm径）","中型（〜11cm径）","大型（〜13cm径）"]
3. 使い方 → options:["バッグのインサート","単独で携帯","スタジオ保管"]`,

    'ギアアップ・アクセサリー': `【Loweproギアアップの質問フロー】1つずつ質問：
1. 収納したいもの → options:["ケーブル・バッテリー","カメラ本体","レンズ","メモリーカード"]
2. 使い方 → options:["バッグのインサート","単独で使う","整理収納"]`
  },

  en: {
    '三脚': `[Tripod Flow] Ask ONE at a time:
1. Main purpose → options:["Photography","Video","Both photo & video"]
2. Gear weight (camera + lens) → options:["Up to 2kg","2-5kg","5-10kg","10kg+"]
3. Shooting scene → options:["Travel/hiking","Street/daily","Studio","Sports/wildlife","Cinema/broadcast"]
4. Material → options:["Carbon (lightweight)","Aluminum (value)","No preference"]`,

    '三脚（Gitzo）': `[Gitzo Tripod Flow] Ask ONE at a time:
1. Shooting scene → options:["Travel/backpacking","Landscape/long exposure","Wildlife/telephoto","Video/cinema","Studio"]
2. Gear weight → options:["Up to 3kg","3-6kg","6-10kg","10kg+"]
3. Head needed? → options:["Tripod only","Need head too","Already have a head"]
4. Portability → options:["As light as possible","Stability over weight","Balanced"]`,

    'バックパック': `[Lowepro Backpack Flow] Ask ONE at a time:
1. Gear → options:["Mirrorless+2-3 lenses","DSLR+3-4 lenses","Large gear+accessories"]
2. Laptop → options:["Up to 13\"","15\"","Not needed"]
3. Scene → options:["Travel/hiking","Street/daily","Professional","Drone"]`
  }
};

// ────────────────────────────────────────────────
// システムプロンプト構築
// ────────────────────────────────────────────────
function buildGuidancePrompt(lang, category, brand) {
  // カテゴリ名の正規化（英語→日本語フローへのマッピング）
  const catMap = {
    // Manfrotto
    'Tripod': '三脚', 'Head': '雲台',
    'Monopod': '一脚', 'Camera Bag': 'カメラバッグ',
    'Lighting': 'ライティング', 'Accessories': 'アクセサリー',
    // Gitzo
    'Tripod (Gitzo)': '三脚（Gitzo）',
    'Monopod (Gitzo)': '一脚（Gitzo）',
    'Head (Gitzo)': '雲台（Gitzo）',
    'Bag & Accessories': 'バッグ・アクセサリー（Gitzo）',
    // Lowepro
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

⚠️ CRITICAL RULES — NEVER VIOLATE:
1. Output MUST be valid JSON only — absolutely no markdown, no extra text before or after
2. "options" array MUST ALWAYS contain 2-5 items — NEVER null, NEVER empty array []
3. Each option must be short (under 15 characters)
4. The options MUST match the current question you are asking
5. If you ask about shooting scene, options must be scenes. If you ask about weight, options must be weights.
6. NEVER repeat the same options from a previous question`;
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
- PRIORITY ORDER IS MANDATORY:
  * priority=1 (新製品): MUST recommend first if relevant to customer needs
  * priority=2 (現行品): recommend after priority=1 products
  * NEVER recommend priority=3 or 4 products
- Always check priority field and sort recommendations: priority=1 first, then priority=2
- If there are priority=1 products in the list, at least one MUST appear in your recommendations

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

  const { messages, lang = 'ja', brand = null, category = null, forceRecommend = false } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  const detectedCategory = detectCategory(messages, category);
  const userMessages = messages.filter(m => m.role === 'user');
  const lastUserMsg  = userMessages[userMessages.length - 1]?.content || '';

  // レコメンド判定：3回以上の会話 or 明示的なシグナル
  const recommendSignals = /以上です|おすすめして|推薦して|お願いします|please recommend|show me|suggest/i;
  // 最低4回答えた後、または明示的な推薦リクエストがあった場合
  // ただしカテゴリ別の質問フローが完了している場合は推薦
  const minTurns = 4;
  // forceRecommend=true、またはターン数が5以上、または明示的な推薦リクエスト
  const shouldRecommend = (forceRecommend === true) || 
    (userMessages.length >= minTurns && recommendSignals.test(lastUserMsg));

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
        // Manfrotto
        '三脚': null,          // 写真・動画両方含むのでシートフィルターなし
        '雲台': ['02_フォト雲台', '07_ビデオ雲台'],  // フォト・ビデオ雲台のみ（キット除外）
        '一脚': '03_フォト一脚',
        'カメラバッグ': '10_カメラバッグ',
        'ライティング': '11_ライティング',
        'アクセサリー': '04_三脚雲台Acc',
        // Gitzo
        '三脚（Gitzo）': null,
        '一脚（Gitzo）': null,
        '雲台（Gitzo）': null,
        'バッグ・アクセサリー（Gitzo）': null,
        // Lowepro
        'バックパック': 'バックパック',
        'ショルダーバッグ': 'ショルダー・TLZ・スリング',
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
        '三脚':              ['写真撮影メイン', '動画撮影メイン', '写真・動画両方'],
        '雲台':              ['写真撮影メイン', '動画撮影メイン', '写真・動画両方'],
        '一脚':              ['スポーツ・報道', '旅行・登山', '動画・Vlog'],
        'カメラバッグ':      ['バックパック', 'ショルダーバッグ', 'トップローディング'],
        'ライティング':      ['ポートレート', '動画・YouTube', '商品撮影'],
        '三脚（Gitzo）':     ['旅行・登山', '風景・長時間露光', '野鳥・超望遠'],
        '雲台（Gitzo）':     ['写真撮影', '動画撮影', 'パノラマ'],
        'バックパック':      ['ミラーレス+レンズ2〜3本', '一眼+レンズ3〜4本', '大型機材'],
        'ショルダーバッグ':  ['コンパクト1台のみ', 'カメラ1台+レンズ1本', 'カメラ+レンズ複数'],
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
