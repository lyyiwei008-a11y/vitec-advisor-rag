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



async function searchProducts(query, brandFilter = null, categoryFilter = null, limit = 15) {

  console.log("QUERY=", query);
  console.log("CATEGORY=", categoryFilter);

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
    // カテゴリフィルターがある場合は必ず適用（件数が少なくても）
    if (filtered.length > 0) results = filtered;
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

  return results.slice(0, 12);
}

// ────────────────────────────────────────────────
// 質問フロー定義
// ────────────────────────────────────────────────
const FLOWS = {
  ja: {
    '三脚': `【三脚の質問フロー】1つずつ質問：
1. 主な用途 → options:["写真撮影メイン","動画撮影メイン","写真・動画両方"]
2. 使用機材の重さ → options:["〜2kg","2〜5kg","5〜10kg","10kg以上"]
3. 撮影シーン → options:["旅行・登山","街撮り・日常","スタジオ・室内","スポーツ・野鳥","放送・シネマ"]
4. 素材のこだわり → options:["カーボン（軽量優先）","アルミ（コスパ優先）","こだわらない"]
5. 予算感 → options:["〜3万円","3〜8万円","8〜15万円","15万円以上"]`,

    '雲台': `【雲台の質問フロー】1つずつ質問：
1. 主な用途 → options:["写真撮影メイン","動画撮影メイン","写真・動画両方"]
2. 雲台のタイプ → options:["ボールヘッド","3ウェイ","ビデオ雲台（フルード）","ギア雲台","わからない"]
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
2. 収納したい機材 → options:["ミラーレス+レンズ2〜3本","一眼+レンズ3〜4本","大型機材複数"]
3. 最大レンズサイズ → options:["標準ズーム程度","70-200mm","超望遠300mm以上"]
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

    '三脚（Gitzo）': `【Gitzo三脚の質問フロー】1つずつ質問：
1. 撮影シーン → options:["旅行・登山","風景・長時間露光","野鳥・超望遠","動画・映像制作"]
2. カメラ＋レンズの合計重量 → options:["〜3kg","3〜6kg","6〜10kg","10kg以上"]
3. 雲台も必要か → options:["三脚のみ","雲台もセットで欲しい","既に雲台を持っている"]
4. 携帯性のこだわり → options:["できるだけ軽く小さく","安定性重視","バランス重視"]
5. 予算感 → options:["〜5万円","5〜10万円","10〜20万円","20万円以上"]`,

    '一脚（Gitzo）': `【Gitzo一脚の質問フロー】1つずつ質問：
1. 撮影シーン → options:["スポーツ・野鳥","風景・旅行","動画・Vlog"]
2. 機材の重さ → options:["〜3kg","3〜6kg","6kg以上"]
3. 段数のこだわり → options:["コンパクトに畳みたい","剛性重視","こだわらない"]`,

    '雲台（Gitzo）': `【Gitzo雲台の質問フロー】1つずつ質問：
1. 主な用途 → options:["写真撮影","動画撮影","パノラマ・360°"]
2. 機材の重さ → options:["〜5kg","5〜10kg","10〜25kg"]
3. 三脚との組み合わせ → options:["Gitzo三脚と合わせたい","他社三脚を持っている","三脚もこれから購入"]`,

    'バッグ・アクセサリー（Gitzo）': `【Gitzoバッグの質問フロー】1つずつ質問：
1. 何を収納したいか → options:["三脚バッグ","カメラバッグ","アクセサリー"]
2. 対応したい三脚サイズ → options:["コンパクト（トラベラー相当）","中型","大型"]`,

    'バックパック': `【Loweproバックパックの質問フロー】1つずつ質問：
1. 収納したい機材 → options:["ミラーレス+レンズ2〜3本","一眼+レンズ3〜4本","大型機材複数"]
2. 最大レンズサイズ → options:["標準ズーム程度","70-200mm","超望遠・シネレンズ"]
3. PC・タブレット収納 → options:["13インチ以下","15インチ","不要"]
4. 使用シーン → options:["旅行・登山","街撮り・日常","プロ撮影","ドローン運搬"]
5. 防水・レインカバー → options:["必須","あれば嬉しい","不要"]`,

    'ショルダーバッグ': `【Loweproショルダーの質問フロー】1つずつ質問：
1. 収納したい機材 → options:["コンパクト1台のみ","カメラ1台+レンズ1本","カメラ+レンズ複数"]
2. バッグのスタイル → options:["斜めがけショルダー","スリング","トップローディング"]
3. 使用シーン → options:["日常・街撮り","旅行","スポーツ・アウトドア"]`,

    'TLZ・トップローディング': `【Lowepro TLZの質問フロー】1つずつ質問：
1. 収納したいレンズサイズ → options:["〜24-70mm","〜70-200mm","300mm以上"]
2. 重視すること → options:["素早く取り出したい","しっかり保護したい","両方"]
3. 使い方 → options:["単独で使う","他のバッグのインサートとして"]`,

    'レンズ・ハードケース': `【Loweproケースの質問フロー】1つずつ質問：
1. 収納したいもの → options:["交換レンズ","カメラ+アクセサリー","バッテリー・小物"]
2. レンズサイズ → options:["小型（〜8cm径）","中型（〜11cm径）","大型（〜13cm径）"]
3. 使い方 → options:["バッグのインサート","単独で携帯","スタジオ保管"]`,

    'ギアアップ・アクセサリー': `【Loweproギアアップの質問フロー】1つずつ質問：
1. 収納したいもの → options:["ケーブル・バッテリー","カメラ本体","レンズ","メモリーカード"]
2. 使い方 → options:["バッグのインサート","単独で使う","整理収納"]`,
  },

  en: {
    'Tripod': `[Tripod Flow] Ask ONE question at a time:
1. Main purpose → options:["Photography","Video","Both photo & video"]
2. Gear weight (camera + lens) → options:["Up to 2kg","2-5kg","5-10kg","10kg+"]
3. Shooting scene → options:["Travel/hiking","Street/daily","Studio","Sports/wildlife","Cinema/broadcast"]
4. Material → options:["Carbon (lightweight)","Aluminum (value)","No preference"]
5. Budget → options:["Under ¥30,000","¥30,000-80,000","¥80,000-150,000","¥150,000+"]`,

    'Head': `[Head Flow] Ask ONE question at a time:
1. Main purpose → options:["Photography","Video","Both photo & video"]
2. Head type → options:["Ball head","3-way","Fluid (video)","Geared","Not sure"]
3. Gear weight → options:["Up to 2kg","2-5kg","5-10kg","10kg+"]
4. Tripod combination → options:["With Manfrotto tripod","With other brand tripod","Need tripod too"]
5. Budget → options:["Under ¥20,000","¥20,000-50,000","¥50,000-100,000","¥100,000+"]`,

    'Monopod': `[Monopod Flow] Ask ONE question at a time:
1. Main use → options:["Sports & news","Video & vlog","Hiking & travel","Wildlife & telephoto"]
2. Gear weight → options:["Up to 1.5kg","Up to 2.5kg","Up to 5kg","5kg+"]
3. Head needed? → options:["Monopod only","With head set","Already have a head"]
4. Material → options:["Carbon (lightweight)","Aluminum (value)","No preference"]`,

    'Camera Bag': `[Camera Bag Flow] Ask ONE question at a time:
1. Bag style → options:["Backpack","Shoulder bag","Top loading","Any style"]
2. Gear to carry → options:["Mirrorless + 2-3 lenses","DSLR + 3-4 lenses","Large gear multiple"]
3. Largest lens → options:["Standard zoom","70-200mm","Super telephoto 300mm+"]
4. Laptop/tablet → options:["Up to 13\"","15\"","Not needed"]
5. Main scene → options:["Travel/hiking","Street/daily","Professional","Drone transport"]`,

    'Lighting': `[Lighting Flow] Ask ONE question at a time:
1. Main purpose → options:["Portrait","Video/YouTube","Product photography","Outdoor location"]
2. Light source → options:["Strobe","LED","Ring light","Large monoblock"]
3. Stand needed? → options:["Need stand too","Already have one","Accessories only"]
4. Location → options:["Studio fixed","Home/small space","Outdoor mobile","Desktop"]
5. Arm needed? → options:["Needed","Not needed","Not sure"]`,

    'Accessories': `[Accessories Flow] Ask ONE question at a time:
1. Main use → options:["Camera support","Tethered shooting","Lighting support","Other"]
2. Mount point → options:["Tripod","Light stand","Camera body","Wall/ceiling"]
3. Type needed → options:["Magic arm","Clamp","Plate","Strap"]`,

    'Tripod (Gitzo)': `[Gitzo Tripod Flow] Ask ONE question at a time:
1. Shooting scene → options:["Travel/hiking","Landscape/long exposure","Wildlife/telephoto","Video/cinema"]
2. Gear weight → options:["Up to 3kg","3-6kg","6-10kg","10kg+"]
3. Head needed? → options:["Tripod only","Need head too","Already have a head"]
4. Portability → options:["As light as possible","Stability over weight","Balanced"]
5. Budget → options:["Under ¥50,000","¥50,000-100,000","¥100,000-200,000","¥200,000+"]`,

    'Monopod (Gitzo)': `[Gitzo Monopod Flow] Ask ONE question at a time:
1. Shooting scene → options:["Sports/wildlife","Landscape/travel","Video/vlog"]
2. Gear weight → options:["Up to 3kg","3-6kg","6kg+"]
3. Section count → options:["Compact folding (more sections)","Rigidity priority (fewer sections)","No preference"]`,

    'Head (Gitzo)': `[Gitzo Head Flow] Ask ONE question at a time:
1. Main purpose → options:["Photography","Video","Panorama/360°"]
2. Gear weight → options:["Up to 5kg","5-10kg","10-25kg"]
3. Tripod combination → options:["With Gitzo tripod","With other brand tripod","Need tripod too"]`,

    'Bag & Accessories': `[Gitzo Bag Flow] Ask ONE question at a time:
1. What to store → options:["Tripod bag","Camera bag","Accessories"]
2. Tripod size → options:["Compact (Traveler size)","Medium","Large (Systematic size)"]`,

    'Backpack': `[Lowepro Backpack Flow] Ask ONE question at a time:
1. Gear to carry → options:["Mirrorless + 2-3 lenses","DSLR + 3-4 lenses","Large gear + accessories"]
2. Largest lens → options:["Standard zoom","70-200mm","Super telephoto/cine lens"]
3. Laptop → options:["Up to 13\"","15\"","Not needed"]
4. Main scene → options:["Travel/hiking","Street/daily","Professional","Drone transport"]
5. Rain cover → options:["Essential","Nice to have","Not needed"]`,

    'Shoulder Bag': `[Lowepro Shoulder Bag Flow] Ask ONE question at a time:
1. Gear to carry → options:["Compact camera only","Camera + 1 lens","Camera + multiple lenses"]
2. Bag style → options:["Shoulder bag","Sling","Top loading"]
3. Main scene → options:["Daily/street","Travel","Sports/outdoor"]`,

    'TLZ / Top Loading': `[Lowepro TLZ Flow] Ask ONE question at a time:
1. Lens size → options:["Up to 24-70mm","Up to 70-200mm","300mm+"]
2. Priority → options:["Quick access","Solid protection","Both"]
3. Usage → options:["Standalone use","As bag insert"]`,

    'Lens & Hard Case': `[Lowepro Case Flow] Ask ONE question at a time:
1. What to store → options:["Interchangeable lens","Camera + accessories","Battery/small items"]
2. Lens size → options:["Small (~8cm dia.)","Medium (~11cm dia.)","Large (~13cm dia.)"]
3. Usage → options:["As bag insert","Standalone carry","Studio storage"]`,

    'GearUp & Accessories': `[Lowepro GearUp Flow] Ask ONE question at a time:
1. What to store → options:["Cables/batteries","Camera body","Lens","Memory cards"]
2. Usage → options:["As bag insert","Standalone use","Organization"]`,
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
5. NEVER say "他にお伝えできることはありますか" or "Is there anything else" — just ask the next question in the flow
6. NEVER deviate from the flow above — ask questions in exact order, one by one
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

Recommend 5-7 products. Never return empty items array.`;
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
      throw new Error(`query=${query}`);

      // カテゴリ→シートマッピング（Supabaseのcategory列でフィルター）
      const categorySheetMap = {
        // Manfrotto（Supabaseの実際のcategory列名に合わせる）
        '三脚':      ['01_フォト三脚', '08_ビデオ三脚'],
        '雲台':      ['02_フォト雲台', '07_ビデオ雲台'],
        '一脚':      ['03_フォト一脚', '09_ビデオ一脚'],
        'カメラバッグ': '10_カメラバッグ',
        'ライティング': '11_ライティング',
        'アクセサリー': ['04_三脚雲台Acc', '05_VR・テザー', '06_アーム_RC'],
        // Gitzo（実際のSupabaseのcategory列名）
        '三脚（Gitzo）':             '三脚 Tripods',
        '一脚（Gitzo）':             '一脚 Monopods',
        '雲台（Gitzo）':             '雲台 Heads',
        'バッグ・アクセサリー（Gitzo）': 'バッグ・アクセサリー',
        // Lowepro（Supabaseの実際のcategory列名）
        'バックパック':             'バックパック',
        'ショルダーバッグ':         ['ショルダー・TLZ・スリング', 'フォトスポーツ・その他'],
        'TLZ・トップローディング':  'ショルダー・TLZ・スリング',
        'レンズ・ハードケース':     'レンズ・ハードサイドケース',
        'ギアアップ・アクセサリー': ['ギアアップ GearUp', 'プロタクティック アクセサリー'],
        // 英語カテゴリ
        'Tripod':              ['01_フォト三脚', '08_ビデオ三脚'],
        'Head':                ['02_フォト雲台', '07_ビデオ雲台'],
        'Monopod':             ['03_フォト一脚', '09_ビデオ一脚'],
        'Camera Bag':          '10_カメラバッグ',
        'Lighting':            '11_ライティング',
        'Accessories':         ['04_三脚雲台Acc', '05_VR・テザー', '06_アーム_RC'],
        'Backpack':            'バックパック',
        'Shoulder Bag':        ['ショルダー・TLZ・スリング', 'フォトスポーツ・その他'],
        'TLZ / Top Loading':   'ショルダー・TLZ・スリング',
        'Lens & Hard Case':    'レンズ・ハードサイドケース',
        'GearUp & Accessories':['ギアアップ GearUp', 'プロタクティック アクセサリー'],
        'Tripod (Gitzo)':      '三脚 Tripods',
        'Monopod (Gitzo)':     '一脚 Monopods',
        'Head (Gitzo)':        '雲台 Heads',
        'Bag & Accessories':   'バッグ・アクセサリー',
      };
      const categoryFilter = categorySheetMap[detectedCategory];

      // 全ブランド選択時もカテゴリに応じて適切なブランドに絞る
      const loweproCategories = ['バックパック','ショルダーバッグ','TLZ・トップローディング','レンズ・ハードケース','ギアアップ・アクセサリー','Backpack','Shoulder Bag','TLZ / Top Loading','Lens & Hard Case','GearUp & Accessories'];
      const gitzoCategories = ['三脚（Gitzo）','一脚（Gitzo）','雲台（Gitzo）','バッグ・アクセサリー（Gitzo）','Tripod (Gitzo)','Monopod (Gitzo)','Head (Gitzo)','Bag & Accessories'];
      const manfrottoOnlyCategories = ['アクセサリー','ライティング','Accessories','Lighting'];

      let effectiveBrand = brand;
      if (!brand) {
        if (loweproCategories.includes(detectedCategory)) effectiveBrand = 'Lowepro';
        else if (gitzoCategories.includes(detectedCategory)) effectiveBrand = 'Gitzo';
        else if (manfrottoOnlyCategories.includes(detectedCategory)) effectiveBrand = 'Manfrotto';
      }

      ragProducts = await searchProducts(query, effectiveBrand, categoryFilter);
    


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
