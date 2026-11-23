// Browser copy of the salesperson product-name rule. The data service inlines
// the same function in tencent-data-core.mjs because the live deployer does
// not copy this file into the runtime. Keep the two copies behavior-identical.
const PRODUCT_NAME_HAN = /[\u3400-\u9fff]/;

export const PRODUCT_NAME_RULE = '产品名称必须包含中文，英文可以写在中文旁边';

export function productNameReminder(value) {
  const name = String(value ?? '').trim();
  if (!PRODUCT_NAME_HAN.test(name)) return PRODUCT_NAME_RULE;
  return '';
}
