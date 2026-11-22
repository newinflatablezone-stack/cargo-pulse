// Browser copy of the customer rules. The data service inlines the same
// functions in tencent-data-core.mjs because the live deployer does not copy
// this file into the runtime. Keep the two copies behavior-identical.
function emailPattern() {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
}

function phonePattern() {
  return /(?:\+|00)?\d[\d\s().-]{5,}\d/g;
}

export function extractCustomerContacts(value) {
  const text = String(value || '');
  const emails = [...new Set((text.match(emailPattern()) || []).map(item => item.toLowerCase()))];
  const phones = new Set();
  for (const raw of text.match(phonePattern()) || []) {
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length < 7 || digits.length > 15) continue;
    phones.add(digits);
    if (digits.length === 13 && digits.startsWith('86')) phones.add(digits.slice(2));
    if (digits.length === 11 && digits.startsWith('1')) phones.add(digits.slice(1));
  }
  return { emails, phones: [...phones] };
}

const STREET = /\b(?:st|street|rd|ave|road|blvd|dr|drive|lane|apt|unit|zip)\b|po\s*box|路|街|道|号|巷|弄|区|市|省|县|镇|村|大厦|室|座/i;

export function customerAddressRemainder(value) {
  return String(value || '').replace(emailPattern(), ' ').replace(phonePattern(), ' ').replace(/\s+/g, ' ').trim();
}

export function customerInfoGaps(value) {
  const contact = extractCustomerContacts(value);
  const remainder = customerAddressRemainder(value);
  const address = remainder.length >= 4 && (/\d/.test(remainder) || /[\u3400-\u9fff]/.test(remainder) || STREET.test(remainder));
  const missing = [];
  if (!address) missing.push('地址');
  if (!contact.emails.length) missing.push('邮箱');
  if (!contact.phones.length) missing.push('电话');
  return missing;
}

export const CUSTOMER_INFO_HINT = '必须包含地址、邮箱和电话';

export function customerInfoReminder(value) {
  const missing = customerInfoGaps(value);
  return missing.length ? `客户信息还缺少：${missing.join('、')}` : '';
}
