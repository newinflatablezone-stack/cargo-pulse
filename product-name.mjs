// Browser copy of the salesperson product-name rule. The data service inlines
// the same function in tencent-data-core.mjs because the live deployer does
// not copy this file into the runtime. Keep the two copies behavior-identical.
const PRODUCT_NAME_HAN = /[\u3400-\u9fff]/;

export const PRODUCT_NAME_UNCHANGED_RULE = '请修改产品名称，不能直接提交 Shopify 导入的名称';
export const PRODUCT_NAME_CHINESE_RULE = '产品名称需要包含中文，英文可以写在中文旁边';

export function productNameReminder(value, original) {
  const name = String(value ?? '').trim();
  const imported = String(original ?? '').trim();
  if (imported && (!name || name === imported)) return PRODUCT_NAME_UNCHANGED_RULE;
  if (!name) return '';
  if (!PRODUCT_NAME_HAN.test(name)) return PRODUCT_NAME_CHINESE_RULE;
  return '';
}
