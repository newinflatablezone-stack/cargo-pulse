// Browser copy of the salesperson product-name rule. The data service inlines
// the same function in tencent-data-core.mjs because the live deployer does
// not copy this file into the runtime. Keep the two copies behavior-identical.
const PRODUCT_NAME_HAN = /\p{Script=Han}/u;
const PRODUCT_NAME_ALLOWED = /^[\p{Script=Han}\p{Nd}\p{P}\s+＋×]+$/u;

export const PRODUCT_NAME_RULE = '产品名称须含中文，可加数字和标点，请勿填写英文字母';

export function productNameReminder(value) {
  const name = String(value ?? '').trim();
  if (!PRODUCT_NAME_HAN.test(name) || !PRODUCT_NAME_ALLOWED.test(name)) return PRODUCT_NAME_RULE;
  return '';
}
