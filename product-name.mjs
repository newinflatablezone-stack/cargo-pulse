// Browser copy of the salesperson product-name rule. The data service inlines
// the same function in tencent-data-core.mjs because the live deployer does
// not copy this file into the runtime. Keep the two copies behavior-identical.
const PRODUCT_NAME_HAN = /[\u3400-\u9fff]/;
const PRODUCT_NAME_LATIN = /[A-Za-z]/;

export const PRODUCT_NAME_RULE = '产品名称必须是中文';

export function productNameReminder(value) {
  const name = String(value ?? '').trim();
  if (!PRODUCT_NAME_HAN.test(name) || PRODUCT_NAME_LATIN.test(name)) return PRODUCT_NAME_RULE;
  return '';
}
