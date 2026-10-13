const DESTINATIONS = [
  ['美国', ['美国', '美國', 'us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america']],
  ['加拿大', ['加拿大', 'canada']],
  ['墨西哥', ['墨西哥', 'mexico', 'méxico']],
  ['澳大利亚', ['澳大利亚', '澳洲', 'australia']],
  ['英国', ['英国', '英國', 'uk', 'u.k.', 'united kingdom', 'great britain', 'england', 'scotland', 'wales', 'northern ireland']],
  ['法国', ['法国', '法國', 'france']],
  ['德国', ['德国', '德國', 'germany', 'deutschland']],
  ['荷兰', ['荷兰', '荷蘭', 'netherlands', 'holland']],
  ['比利时', ['比利时', '比利時', 'belgium']],
  ['卢森堡', ['卢森堡', '盧森堡', 'luxembourg']],
  ['爱尔兰', ['爱尔兰', '愛爾蘭', 'ireland']],
  ['瑞士', ['瑞士', 'switzerland']],
  ['奥地利', ['奥地利', '奧地利', 'austria']],
  ['意大利', ['意大利', '义大利', '義大利', 'italy']],
  ['西班牙', ['西班牙', 'spain']],
  ['葡萄牙', ['葡萄牙', 'portugal']],
  ['丹麦', ['丹麦', '丹麥', 'denmark']],
  ['瑞典', ['瑞典', 'sweden']],
  ['挪威', ['挪威', 'norway']],
  ['芬兰', ['芬兰', '芬蘭', 'finland']],
  ['冰岛', ['冰岛', '冰島', 'iceland']],
  ['日本', ['日本', 'japan']],
  ['新加坡', ['新加坡', 'singapore']],
  ['新西兰', ['新西兰', '新西蘭', '纽西兰', '紐西蘭', 'new zealand']],
  ['韩国', ['韩国', '韓國', '南韩', '南韓', 'south korea', 'republic of korea', 'korea republic of']]
];

export const MAINSTREAM_DESTINATIONS = DESTINATIONS.map(([name]) => name);

export function normalizeDestination(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const ALIASES = new Map(DESTINATIONS.flatMap(([name, aliases]) => aliases.map(alias => [normalizeDestination(alias), name])));

export function classifyDestination(value) {
  const input = String(value || '').trim();
  const canonical = ALIASES.get(normalizeDestination(input)) || null;
  return {
    input,
    canonical,
    mainstream: Boolean(canonical),
    risk: input && !canonical ? 'non_mainstream' : input ? 'mainstream' : 'unknown'
  };
}
