// Turn a plain-English garment description into build settings (keyword based, no AI service).
// Anything mentioned overrides what was measured from the photo; anything not mentioned keeps the photo.

const RULES = [
  // type
  { re: /\b(pants?|trousers?|jeans?|denims?|leggings?|joggers?|sweat ?pants?|track ?pants?|slacks|chinos?|cargos?|flares|bell[- ]?bottoms?|shorts?)\b/, set: { type: 'pants' }, label: 'Pants' },
  { re: /\bskirts?\b/, set: { type: 'skirt' }, label: 'Skirt' },
  { re: /\b(tops?|tees?|t-?shirts?|shirts?|blouses?|sweaters?|jumpers?|hoodies?|sweatshirts?|tanks?|camis?|crop ?tops?|long ?sleeves?|tunics?|cardigans?)\b/, set: { type: 'top' }, label: 'Top' },
  // pants leg shape
  { re: /\b(flared?|flares|bell[- ]?bottoms?|bell)\b/, set: { leg: 'flare' }, label: 'Flared' },
  { re: /\bboot ?cut\b/, set: { leg: 'bootcut' }, label: 'Bootcut' },
  { re: /\b(wide[- ]?leg|palazzo|baggy jeans|wide)\b/, set: { leg: 'wide' }, label: 'Wide leg' },
  { re: /\bstraight(?:[- ]?leg)?\b/, set: { leg: 'straight' }, label: 'Straight leg' },
  { re: /\b(skinny|leggings?|jeggings?)\b/, set: { leg: 'skinny' }, label: 'Skinny' },
  { re: /\b(joggers?|tapered|sweat ?pants?|track ?pants?|cuffed)\b/, set: { leg: 'tapered' }, label: 'Tapered + cuffs' },
  // rise
  { re: /\blow[- ]?(rise|waist(ed)?)\b|\bhip[- ]?huggers?\b/, set: { rise: 'low' }, label: 'Low rise' },
  { re: /\bmid[- ]?(rise|waist(ed)?)\b/, set: { rise: 'mid' }, label: 'Mid rise' },
  { re: /\b(high|ultra[- ]?high)[- ]?(rise|waist(ed)?)\b|\bpaper ?bag\b/, set: { rise: 'high' }, label: 'High rise' },
  // fit
  { re: /\b(skin[- ]?tight|tight|bodycon|compression|second[- ]?skin)\b/, set: { fit: 'tight' }, label: 'Tight' },
  { re: /\b(fitted|slim|tailored|snug)\b/, set: { fit: 'fitted' }, label: 'Fitted' },
  { re: /\b(relaxed|loose|easy fit)\b/, set: { fit: 'relaxed' }, label: 'Relaxed' },
  { re: /\b(baggy|oversized|boxy|slouchy)\b/, set: { fit: 'baggy' }, label: 'Baggy' },
  // pants length
  { re: /\b(short shorts|hot ?pants|booty shorts)\b/, set: { length: 'microshorts' }, label: 'Short shorts' },
  { re: /\bshorts?\b/, set: { length: 'shorts' }, label: 'Shorts' },
  { re: /\b(bermudas?|knee[- ]?length)\b/, set: { length: 'knee' }, label: 'Knee length' },
  { re: /\b(capris?|pedal ?pushers?|mid[- ]?calf)\b/, set: { length: 'calf' }, label: 'Mid-calf' },
  { re: /\b(cropped|ankle[- ]?length|7\/8)\b/, set: { length: 'ankle' }, label: 'Ankle length' },
  { re: /\b(full[- ]?length|long)\b(?![- ]?sleeve)/, set: { length: 'full' }, label: 'Full length' },
  { re: /\b(floor[- ]?length|floor|puddle|stacked)\b/, set: { length: 'floor' }, label: 'Floor length' },
  // skirt length + shape
  { re: /\bmicro[- ]?(mini|skirt)\b/, set: { length: 'micro' }, label: 'Micro' },
  { re: /\bmini\b/, set: { length: 'mini' }, label: 'Mini' },
  { re: /\bmidi\b/, set: { length: 'midi' }, label: 'Midi' },
  { re: /\bmaxi\b/, set: { length: 'maxi' }, label: 'Maxi' },
  { re: /\b(pencil|tube|bodycon skirt)\b/, set: { skirt: 'pencil' }, label: 'Pencil' },
  { re: /\ba[- ]?line\b/, set: { skirt: 'aline' }, label: 'A-line' },
  { re: /\b(circle|skater|full skirt|flowy|pleated|tiered)\b/, set: { skirt: 'full' }, label: 'Full / flowy' },
  // tops
  { re: /\bcrop(ped)?[- ]?(top|tee|hoodie|sweater)?\b|\bcropped\b/, set: { topLen: 'crop' }, label: 'Cropped' },
  { re: /\b(longline|tunic|longer length|long top)\b/, set: { topLen: 'long' }, label: 'Longline' },
  { re: /\b(sleeveless|tank|cami|vest|strappy)\b/, set: { sleeve: 'none' }, label: 'Sleeveless' },
  { re: /\bcap[- ]?sleeves?\b/, set: { sleeve: 'cap' }, label: 'Cap sleeves' },
  { re: /\b(short[- ]?sleeves?|tee|t-?shirt)\b/, set: { sleeve: 'short' }, label: 'Short sleeves' },
  { re: /\b(elbow[- ]?(length )?sleeves?|half[- ]?sleeves?)\b/, set: { sleeve: 'elbow' }, label: 'Elbow sleeves' },
  { re: /\b(3\/4|three[- ]?quarter)[- ]?sleeves?\b/, set: { sleeve: 'threequarter' }, label: '¾ sleeves' },
  { re: /\b(long[- ]?sleeves?|long[- ]?sleeved|hoodie|sweater|sweatshirt|jumper|cardigan)\b/, set: { sleeve: 'long' }, label: 'Long sleeves' },
];

export function parseDescription(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[’']/g, '')} `, out = { labels: [] };
  for (const r of RULES) {
    if (!r.re.test(t)) continue;
    // later, more specific rules win (e.g. "short shorts" over "shorts", "floor length" over "long")
    for (const [k, v] of Object.entries(r.set)) {
      if (k === 'length' && out.length && LENGTH_PRIORITY[out.length] > LENGTH_PRIORITY[v]) continue;
      if (k === 'sleeve' && out.sleeve && r.label === 'Short sleeves' && out.sleeve !== 'short') continue;
      out[k] = v;
    }
    if (!out.labels.includes(r.label)) out.labels.push(r.label);
  }
  // "shorts" implies pants; "long" alone shouldn't fight a more specific length
  if (out.length === 'shorts' || out.length === 'microshorts') out.type = out.type || 'pants';
  // drop labels that were overridden by something more specific
  const keep = new Set(Object.entries(out).filter(([k]) => k !== 'labels').map(([k, v]) => `${k}:${v}`));
  out.labels = out.labels.filter((l) => RULES.some((r) => r.label === l && Object.entries(r.set).every(([k, v]) => keep.has(`${k}:${v}`))));
  return out;
}
const LENGTH_PRIORITY = { full: 1, floor: 2, ankle: 2, calf: 2, knee: 2, shorts: 2, microshorts: 3, mini: 2, micro: 3, midi: 2, maxi: 2 };

// suggestion chips for the UI, per garment type
export const SUGGESTIONS = {
  pants: ['high rise', 'low rise', 'flared', 'bootcut', 'wide leg', 'straight leg', 'skinny', 'joggers', 'fitted', 'baggy', 'floor length', 'ankle length', 'shorts'],
  skirt: ['mini', 'midi', 'maxi', 'pencil', 'a-line', 'flowy', 'fitted', 'low rise', 'high waisted'],
  top: ['crop top', 'longline', 'sleeveless', 'short sleeves', '3/4 sleeves', 'long sleeves', 'fitted', 'oversized'],
};
