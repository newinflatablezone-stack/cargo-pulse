export const MANUAL_FACTORY_LABEL = '其他（手动输入）';

export function bindManualFactorySuggestion(input) {
  if (!input) return;
  const clearSuggestion = () => {
    if (input.value !== MANUAL_FACTORY_LABEL) return;
    input.value = '';
    input.placeholder = '请输入工厂名称';
    input.focus();
  };
  input.addEventListener('input', clearSuggestion);
  input.addEventListener('change', clearSuggestion);
}
